import * as iasql from '../../src/services/iasql';
import {
  defaultRegion,
  execComposeDown,
  execComposeUp,
  finish,
  getPrefix,
  itDocs,
  runBegin,
  runCommit,
  runInstall,
  runQuery,
  runUninstall,
} from '../helpers';

const prefix = getPrefix();
const dbAlias = 'acmrequesttest';
const domainName = `${prefix}.skybase.dev`;

const begin = runBegin.bind(null, dbAlias);
const commit = runCommit.bind(null, dbAlias);
const query = runQuery.bind(null, dbAlias);
const install = runInstall.bind(null, dbAlias);
const uninstall = runUninstall.bind(null, dbAlias);
const region = defaultRegion();
const modules = ['aws_acm', 'aws_route53', 'aws_elb'];

jest.setTimeout(360000);
beforeAll(async () => await execComposeUp());
afterAll(async () => await execComposeDown());

let username: string, password: string;

describe('AwsAcm Request Integration Testing', () => {
  it('creates a new test db', done => {
    (async () => {
      try {
        const { user, password: pgPassword } = await iasql.connect(dbAlias, 'not-needed', 'not-needed');
        username = user;
        password = pgPassword;
        if (!username || !password) throw new Error('Did not fetch pg credentials');
        done();
      } catch (e) {
        done(e);
      }
    })();
  });

  itDocs('installs the aws_account module', install(['aws_account']));

  it(
    'inserts aws credentials',
    query(
      `
    INSERT INTO aws_credentials (access_key_id, secret_access_key)
    VALUES ('${process.env.STAGING_ACCESS_KEY_ID}', '${process.env.STAGING_SECRET_ACCESS_KEY}')
  `,
      undefined,
      false,
      () => ({ username, password }),
    ),
  );

  it('starts a transaction', begin());

  it('syncs the regions', commit());

  it(
    'sets the default region',
    query(
      `
    UPDATE aws_regions SET is_default = TRUE WHERE region = '${region}';
  `,
      undefined,
      true,
      () => ({ username, password }),
    ),
  );

  itDocs('installs the acm module alone', install(['aws_acm']));

  it('adds a new certificate to request with a domain without route53 support', done => {
    query(`
        SELECT * FROM certificate_request('fakeDomain.com', 'DNS', '${region}', '{}');
      `)((e: any) => {
      if (e instanceof Error) {
        return done();
      }
      return done('Somehow did not get an error back from the function');
    });
  });

  it('installs the rest of the modules needed', install(modules));

  it(
    'adds a new certificate to request with a fake domain',
    query(`
      SELECT * FROM certificate_request('fakeDomain.com', 'DNS', '${region}', '{}');
    `),
  );

  it(
    'check new certificate was not created',
    query(
      `
    SELECT *
    FROM certificate
    WHERE domain_name = 'fakeDomain.com';
  `,
      (res: any[]) => expect(res.length).toBe(0),
    ),
  );

  itDocs(
    'adds a new certificate to request',
    query(`
      SELECT * FROM certificate_request('${domainName}', 'DNS', '${region}', '{}');
  `),
  );

  itDocs(
    'check new certificate added and validated',
    query(
      `
    SELECT *
    FROM certificate
    WHERE domain_name = '${domainName}' AND status='ISSUED';
  `,
      (res: any[]) => expect(res.length).toBe(1),
    ),
  );

  it('uninstalls modules', uninstall(modules));

  it('installs modules', install(modules));

  it(
    'check certificate count after uninstall/install',
    query(
      `
    SELECT *
    FROM certificate
    WHERE domain_name = '${domainName}';
  `,
      (res: any[]) => expect(res.length).toBe(1),
    ),
  );

  it('starts a transaction', begin());

  itDocs(
    'deletes a certificate requested',
    query(
      `
    DELETE FROM certificate
    WHERE domain_name = '${domainName}';
  `,
      undefined,
      true,
      () => ({ username, password }),
    ),
  );

  it('applies the delete', commit());

  it(
    'check certificate count after delete',
    query(
      `
    SELECT *
    FROM certificate
    WHERE domain_name = '${domainName}' AND status='ISSUED';
  `,
      (res: any[]) => expect(res.length).toBe(0),
    ),
  );

  itDocs(
    'creates a certificate request in non-default region',
    query(`
      SELECT * FROM certificate_request('${domainName}', 'DNS', 'us-east-1', '{}');
  `),
  );

  itDocs(
    'checks the certificate in non-default region is created and validated',
    query(
      `
      SELECT *
      FROM certificate
      WHERE domain_name = '${domainName}'
        AND status = 'ISSUED'
        AND region = 'us-east-1';
  `,
      (res: any[]) => expect(res.length).toBe(1),
    ),
  );

  it('starts a transaction', begin());

  it(
    'deletes the certificate issued in the non-default region',
    query(
      `
      DELETE
      FROM certificate
      WHERE domain_name = '${domainName}';
  `,
      undefined,
      true,
      () => ({ username, password }),
    ),
  );

  it('applies the deletion of the certificate in the non-default region', commit());

  it(
    'checks the deletion of the certificate in the non-default region',
    query(
      `
      SELECT *
      FROM certificate
      WHERE domain_name = '${domainName}'
        AND status = 'ISSUED'
        AND region = 'us-east-1';
  `,
      (res: any[]) => expect(res.length).toBe(0),
    ),
  );

  it('deletes the test db', done => void iasql.disconnect(dbAlias, 'not-needed').then(...finish(done)));
});
