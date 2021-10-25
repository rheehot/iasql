import * as express from 'express'
import { SnakeNamingStrategy, } from 'typeorm-naming-strategies'

import * as Modules from '../modules'
import config from '../config'
import { AWS, } from '../services/gateways/aws'
import { IasqlModule, } from '../entity'
import { TypeormWrapper, } from '../services/typeorm'

export const mod = express.Router();
mod.use(express.json());

// Mimicking `apt` in this due to the similarities in environment modules/packages are being managed
// within. Here's the list of commands `apt` itself claims are commonly used. Which should we
// support, and is there anything not present that we need to due to particulars of IaSQL? Maybe an
// "enable/disable" endpoint to stop actions for a given module (and anything dependent on it) but
// not removing it from the DB?
//
// Most used commands:
//  list - list packages based on package names
//  search - search in package descriptions
//  show - show package details
//  install - install packages
//  reinstall - reinstall packages
//  remove - remove packages
//  autoremove - Remove automatically all unused packages
//  update - update list of available packages
//  upgrade - upgrade the system by installing/upgrading packages
//  full-upgrade - upgrade the system by removing/installing/upgrading packages
//  edit-sources - edit the source information file
//  satisfy - satisfy dependency strings

// Needed at the beginning
mod.post('/list', async (req, res) => {
  if (req.body.all) {
    res.json(Object.values(Modules)
    .filter(m => m.hasOwnProperty('mappers') && m.hasOwnProperty('name'))
    .map(m => m.name));
  } else if (req.body.installed && req.body.dbname) {
    const orm = await TypeormWrapper.createConn(req.body.dbname, {
      name: req.body.dbname,
      type: 'postgres',
      username: 'postgres', // TODO: Should we use the user's account for this?
      password: 'test',
      host: 'postgresql',
      entities: [IasqlModule],
      namingStrategy: new SnakeNamingStrategy(), // TODO: Do we allow modules to change this?
    });
    const modules = await orm.find(IasqlModule);
    res.json(modules.map((m: IasqlModule) => m.name));
  } else {
    res.end(JSON.stringify("ERROR", undefined, '  '));
  }
});

// Needed when we have more than a handful of packages
mod.post('/search', (_req, res) => res.end('ok'));

// Needed when we have metadata attached to the packages to even show
mod.post('/show', (_req, res) => res.end('ok'));

// Needed at the beginning
mod.post('/install', async (req, res) => {
  // TODO: Add security to all of these endpoints
  // Don't do anything if we don't know what database to impact
  if (!req.body.dbname) return res.json("Missing 'dbname' to install into");
  // Also don't do anything if we don't have any list of modules to install
  if (!Array.isArray(req.body.list)) return res.json("ERROR: No packages provided in 'list' property");
  // Check to make sure that all specified modules actually exist
  const modules = req.body.list.map((n: string) => Object.values(Modules).find(m => m.name === n)) as Modules.ModuleInterface[];
  if (modules.some((m: any) => m === undefined)) {
    return res.json(`ERROR. The following modules do not exist: ${
      req.body.list.filter((n: string) => !Object.values(Modules).find(m => m.name === n)).join(' , ')
    }`);
  }
  // Grab all of the entities from the module plus the IaSQL Module entity itself and create the
  // TypeORM connection with it.
  const entities = modules.map((m: any) => m.mappers.map((ma: any) => ma.entity)).flat();
  entities.push(IasqlModule);
  const orm = await TypeormWrapper.createConn(req.body.dbname, {
    name: req.body.dbname,
    type: 'postgres',
    username: 'postgres', // TODO: Should we use the user's account for this?
    password: 'test',
    host: 'postgresql',
    entities,
    namingStrategy: new SnakeNamingStrategy(), // TODO: Do we allow modules to change this?
  });
  const queryRunner = orm.createQueryRunner();
  await queryRunner.connect();
  // See what modules are already installed and prune them from the list
  const existingModules = (await orm.find(IasqlModule)).map((m: IasqlModule) => m.name);
  for (let i = 0; i < modules.length; i++) {
    if (existingModules.includes(modules[i].name)) {
      modules.splice(i, 1);
      i--;
    }
  }
  // See if we need to abort because now there's nothing to do
  if (modules.length === 0) {
    return res.json("All modules already installed. Aborting");
  }
  // Scan the database and see if there are any collisions
  const tables = (await queryRunner.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
  `)).map((t: any) => t.table_name);
  const tableCollisions: { [key: string]: string[], } = {};
  let hasCollision = false;
  for (let mod of modules) {
    tableCollisions[mod.name] = [];
    if (mod.provides?.tables) {
      for (let t of mod.provides.tables) {
        if (tables.includes(t)) {
          tableCollisions[mod.name].push(t);
          hasCollision = true;
        }
      }
    }
  }
  if (hasCollision) {
    return res.json(`Collision with existing tables detected.
${Object.keys(tableCollisions)
.filter(m => tableCollisions[m].length > 0)
.map(m => `Module ${m} collides with tables: ${tableCollisions[m].join(', ')}`)
.join('\n')
}`);
  }
  // Sort the modules based on their dependencies, with both root-to-leaf order and vice-versa
  const rootToLeafOrder = [...modules].sort((a, b) => {
    // Assuming no dependency loops
    if (a.dependencies.includes(b.name)) return 1;
    if (b.dependencies.includes(a.name)) return -1;
    return 0;
  });
  const leafToRootOrder = [...rootToLeafOrder].reverse();
  // Actually run the installation. First running all of the preinstall scripts from leaf-to-root,
  // then all of the postinstall scripts from root-to-leaf. Wrapped in a transaction so any failure
  // at this point when we're actually mutating the database doesn't leave things in a busted state.
  await queryRunner.startTransaction();
  try {
    for (let mod of leafToRootOrder) {
      if (mod.migrations?.preinstall) {
        await mod.migrations.preinstall(queryRunner);
      }
    }
    for (let mod of rootToLeafOrder) {
      if (mod.migrations?.preinstall) {
        await mod.migrations.preinstall(queryRunner);
      }
      if (mod.migrations?.postinstall) {
        await mod.migrations.postinstall(queryRunner);
      }
      const e = new IasqlModule();
      e.name = mod.name;
      e.installed = true;
      e.enabled = true;
      await orm.save(IasqlModule, e);
    }
    await queryRunner.commitTransaction();
  } catch (e) {
    await queryRunner.rollbackTransaction();
    return res.json(`Error: ${(e as any).message}`);
  } finally {
    await queryRunner.release();
  }
  res.json("Done!");
});

// Needed at the beginning
mod.post('/remove', async (req, res) => {
  // TODO: Add security to all of these endpoints
  // Don't do anything if we don't know what database to impact
  if (!req.body.dbname) return res.json("Missing 'dbname' to install into");
  // Also don't do anything if we don't have any list of modules to install
  if (!Array.isArray(req.body.list)) return res.json("ERROR: No packages provided in 'list' property");
  // Check to make sure that all specified modules actually exist
  const modules = req.body.list.map((n: string) => Object.values(Modules).find(m => m.name === n)) as Modules.ModuleInterface[];
  if (modules.some((m: any) => m === undefined)) {
    return res.json(`ERROR. The following modules do not exist: ${
      req.body.list.filter((n: string) => !Object.values(Modules).find(m => m.name === n)).join(' , ')
    }`);
  }
  // Grab all of the entities from the module plus the IaSQL Module entity itself and create the
  // TypeORM connection with it.
  const entities = modules.map((m: any) => m.mappers.map((ma: any) => ma.entity)).flat();
  entities.push(IasqlModule);
  const orm = await TypeormWrapper.createConn(req.body.dbname, {
    name: req.body.dbname,
    type: 'postgres',
    username: 'postgres', // TODO: Should we use the user's account for this?
    password: 'test',
    host: 'postgresql',
    entities,
    namingStrategy: new SnakeNamingStrategy(), // TODO: Do we allow modules to change this?
  });
  const queryRunner = orm.createQueryRunner();
  await queryRunner.connect();
  // See what modules are already removed and prune them from the list
  const existingModules = (await orm.find(IasqlModule)).map((m: IasqlModule) => m.name);
  for (let i = 0; i < modules.length; i++) {
    if (!existingModules.includes(modules[i].name)) {
      modules.splice(i, 1);
      i--;
    }
  }
  // See if we need to abort because now there's nothing to do
  if (modules.length === 0) {
    return res.json("All modules already removed. Aborting");
  }
  // Sort the modules based on their dependencies, with both root-to-leaf order and vice-versa
  const rootToLeafOrder = [...modules].sort((a, b) => {
    // Assuming no dependency loops
    if (a.dependencies.includes(b.name)) return 1;
    if (b.dependencies.includes(a.name)) return -1;
    return 0;
  });
  const leafToRootOrder = [...rootToLeafOrder].reverse();
  // Actually run the removal. First running all of the preremove scripts from leaf-to-root, then
  // all of the postremove scripts from root-to-leaf. Wrapped in a transaction so any failure at
  // this point when we're actually mutating the database doesn't leave things in a busted state.
  await queryRunner.startTransaction();
  try {
    for (let mod of leafToRootOrder) {
      if (mod.migrations?.preinstall) {
        await mod.migrations.preinstall(queryRunner);
      }
    }
    for (let mod of rootToLeafOrder) {
      if (mod.migrations?.preremove) {
        await mod.migrations.preremove(queryRunner);
      }
      if (mod.migrations?.postremove) {
        await mod.migrations.postremove(queryRunner);
      }
      const e = await orm.findOne(IasqlModule, { name: mod.name, });
      await orm.remove(IasqlModule, e);
    }
    await queryRunner.commitTransaction();
  } catch (e) {
    await queryRunner.rollbackTransaction();
    return res.json(`Error: ${(e as any).message}`);
  } finally {
    await queryRunner.release();
  }
  res.json("Done!");
});

// Needed before first beta
mod.post('/upgrade', (_req, res) => res.end('ok'));