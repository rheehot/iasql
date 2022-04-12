import config from '../../src/config';
import * as iasql from '../../src/services/iasql'
import { runQuery, runInstall, runUninstall, runApply, finish, execComposeUp, execComposeDown, runSync, } from '../helpers'

const dbAlias = 'ec2test';
// specific to us-west-2, varies per region
const region = 'us-west-2'
const amznAmiId = 'ami-06cffe063efe892ad';
const ubuntuAmiId = 'ami-0892d3c7ee96c0bf7';

const apply = runApply.bind(null, dbAlias);
const sync = runSync.bind(null, dbAlias);
const query = runQuery.bind(null, dbAlias);
const install = runInstall.bind(null, dbAlias);
const uninstall = runUninstall.bind(null, dbAlias);
const modules = ['aws_ec2', 'aws_security_group', 'aws_vpc'];

jest.setTimeout(240000);
beforeAll(async () => await execComposeUp());
afterAll(async () => await execComposeDown(modules));

describe('EC2 Integration Testing', () => {
  it('creates a new test db', (done) => void iasql.connect(
    dbAlias,
    region,
    process.env.AWS_ACCESS_KEY_ID ?? 'barf',
    process.env.AWS_SECRET_ACCESS_KEY ?? 'barf',
    'not-needed', 'not-needed').then(...finish(done)));

  it('creates a new test db to test sync', (done) => void iasql.connect(
    `${dbAlias}_sync`,
    'us-east-1', // Share region with common tests
    process.env.AWS_ACCESS_KEY_ID ?? 'barf',
    process.env.AWS_SECRET_ACCESS_KEY ?? 'barf',
    'not-needed', 'not-needed').then(...finish(done)));

  it('installs the ec2 module', install(modules));

  it('adds two ec2 instance', (done) => {
    query(`
      BEGIN;
        INSERT INTO instance (name, ami, instance_type)
          VALUES ('i-1','${ubuntuAmiId}', 't2.micro');
        INSERT INTO instance_security_groups (instance_id, security_group_id) SELECT
          (SELECT id FROM instance WHERE name='i-1'),
          (SELECT id FROM security_group WHERE group_name='default');
      COMMIT;

      BEGIN;
        INSERT INTO instance (name, ami, instance_type)
          VALUES ('i-2','${amznAmiId}', 't2.micro');
        INSERT INTO instance_security_groups (instance_id, security_group_id) SELECT
          (SELECT id FROM instance WHERE name='i-2'),
          (SELECT id FROM security_group WHERE group_name='default');
      COMMIT;
    `)((e?: any) => {
      if (!!e) return done(e);
      done();
    });
  });

  it('Undo changes', sync());

  it('check number of instances', query(`
    SELECT *
    FROM instance
    WHERE name = ANY(array['i-1', 'i-2']);
  `, (res: any[]) => expect(res.length).toBe(0)));

  it('adds two ec2 instance', (done) => {
    query(`
      BEGIN;
        INSERT INTO instance (name, ami, instance_type)
          VALUES ('i-1','${ubuntuAmiId}', 't2.micro');
        INSERT INTO instance_security_groups (instance_id, security_group_id) SELECT
          (SELECT id FROM instance WHERE name='i-1'),
          (SELECT id FROM security_group WHERE group_name='default');
      COMMIT;

      BEGIN;
        INSERT INTO instance (name, ami, instance_type)
          VALUES ('i-2','${amznAmiId}', 't2.micro');
        INSERT INTO instance_security_groups (instance_id, security_group_id) SELECT
          (SELECT id FROM instance WHERE name='i-2'),
          (SELECT id FROM security_group WHERE group_name='default');
      COMMIT;
    `)((e?: any) => {
      if (!!e) return done(e);
      done();
    });
  });

  it('check number of instances', query(`
    SELECT *
    FROM instance
    WHERE name = ANY(array['i-1', 'i-2']);
  `, (res: any[]) => expect(res.length).toBe(2)));

  it('applies the created instances', apply());

  it('syncs the changes from the first database to the second', runSync(`${dbAlias}_sync`));

  it('set both ec2 instances to the same ami', query(`
    UPDATE instance SET ami = '${amznAmiId}' WHERE name = 'i-1';
  `));

  it('applies the instances change', apply());

  it('check number of instances', query(`
    SELECT *
    FROM instance;
  `, (res: any[]) => expect(res.length).toBe(2)));

  it('check instance ami update', query(`
    SELECT *
    FROM instance
    WHERE ami = '${ubuntuAmiId}';
  `, (res: any[]) => expect(res.length).toBe(0)));

  it('uninstalls the ec2 module', uninstall(modules));

  it('installs the ec2 module', install(modules));

  it('check number of instances', query(`
    SELECT *
    FROM instance;
  `, (res: any[]) => expect(res.length).toBe(2)));

  it('deletes both ec2 instances', query(`
    DELETE FROM instance;
  `));

  it('applies the instances deletion', apply());

  it('check number of instances', query(`
    SELECT *
    FROM instance;
  `, (res: any[]) => expect(res.length).toBe(0)));

  it('deletes the test db', (done) => void iasql
    .disconnect(dbAlias, 'not-needed')
    .then(...finish(done)));

  it('deletes the test sync db', (done) => void iasql
    .disconnect(`${dbAlias}_sync`, 'not-needed')
    .then(...finish(done)));
});

describe('EC2 install/uninstall', () => {
  it('creates a new test db', (done) => void iasql.connect(
    dbAlias,
    'us-east-1', // Share region with common tests
    process.env.AWS_ACCESS_KEY_ID ?? 'barf',
    process.env.AWS_SECRET_ACCESS_KEY ?? 'barf',
    'not-needed', 'not-needed').then(...finish(done)));

  it('installs the ec2 module', install(modules));

  it('uninstalls the ec2 module', uninstall(modules));

  it('installs all modules', (done) => void iasql.install(
    [],
    dbAlias,
    config.dbUser,
    true).then(...finish(done)));

  it('uninstall ec2 using overloaded sp', query(`
    select iasql_uninstall('aws_ec2');
  `));

  it('install ec2 using overloaded sp', query(`
    select iasql_install('aws_ec2');
  `));

  it('deletes the test db', (done) => void iasql
    .disconnect(dbAlias, 'not-needed')
    .then(...finish(done)));
});
