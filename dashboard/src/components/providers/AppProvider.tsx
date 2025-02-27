import React, { useCallback, useContext, useReducer } from 'react';

import * as semver from 'semver';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

import { ConfigInterface } from '@/config/config';
import * as DbActions from '@/services/dbApi';
import * as Posthog from '@/services/posthog';

import { useAppConfigContext } from './ConfigProvider';

const nameGenConfig = {
  dictionaries: [adjectives, colors, animals],
};

const AppContext = React.createContext({} as AppStore);

const useAppContext = () => {
  return useContext(AppContext);
};

export enum ActionType {
  InitialLoad = 'InitialLoad',
  NewDb = 'NewDb',
  List = 'List',
  Disconnect = 'Disconnect',
  UpgradeDb = 'UpgradeDb',
  DisconnectDb = 'DisconnectDb',
  UninstallModule = 'UninstallModule',
  InstallModule = 'InstallModule',
  SelectDb = 'SelectDb',
  RunSql = 'RunSql',
  RunAutocompleteSql = 'RunAutocompleteSql',
  EditContent = 'EditContent',
  TrackEvent = 'TrackEvent',
  FetchData = 'FetchData',
  Stop = 'Stop',
  RunningSql = 'RunningSql',
  ShowDisconnect = 'ShowDisconnect',
  ShowConnect = 'ShowConnect',
  ResetNewDb = 'ResetNewDb',
  ResetError = 'ResetError',
  SetError = 'SerError',
  EditorNewTab = 'EditorNewTab',
  EditorSelectTab = 'EditorSelectTab',
  SelectAppTheme = 'SelectAppTheme',
  EditorCloseTab = 'EditorCloseTab',
  SelectTable = 'SelectTable',
}

interface Payload {
  token?: string;
  action: ActionType;
  // TODO: ADD DATA TYPE!!!
  data?: any;
}

interface AppState {
  token?: string;
  // TODO: ADD DB TYPE!!!
  selectedDb: any;
  oldestVersion?: string;
  latestVersion?: string;
  isRunningSql: boolean;
  databases: any[];
  error: string | null;
  newDb?: any;
  allModules: { [moduleName: string]: string[] };
  functions: {
    [moduleName: string]: {
      [functionName: string]: string;
    };
  };
  installedModules: {
    [moduleName: string]: { [tableName: string]: { [columnName: string]: string } & { recordCount: number } };
  };
  isDarkMode: boolean;
  shouldShowDisconnect: boolean;
  shouldShowConnect: boolean;
  editorTabsCreated: number;
  editorSelectedTab: number;
  editorTabs: {
    title: string;
    action?: () => void;
    className?: string;
    width?: string;
    content: string;
    queryRes?: any | null;
    closable?: boolean;
    isRunning?: boolean;
  }[];
  forceRun: boolean;
}

interface AppStore extends AppState {
  dispatch: (payload: Payload) => Promise<void>;
}

const initializingQueries = `
  select * from iasql_help();
  select
    t.module, c.table_name, c.ordinal_position, c.column_name, c.data_type
  from information_schema.columns as c
  inner join iasql_tables as t on c.table_name = t.table
  order by
    table_name, ordinal_position;
  select * from iasql_modules_list();
  select
    t.table as table_name,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table), FALSE, TRUE, '')))[1]::text::int AS record_count
  from iasql_tables as t;
`;

const reducer = (state: AppState, payload: Payload): AppState => {
  const { error } = payload?.data ?? { error: null };
  if (error) {
    return { ...state, error };
  }
  switch (payload.action) {
    case ActionType.SelectDb: {
      const { db } = payload.data;
      db.isUnsupported =
        !semver.valid(db?.version) || (!!state.oldestVersion && semver.lt(db?.version, state.oldestVersion));
      const tabsCopy = [...state.editorTabs];
      if (db?.alias !== state.selectedDb?.alias) {
        tabsCopy.map(t => (t.queryRes = undefined));
      }
      return { ...state, selectedDb: db, editorTabs: tabsCopy };
    }
    case ActionType.InitialLoad: {
      const { token } = payload;
      const { initialDatabases, latestVersion, oldestVersion } = payload.data;
      return { ...state, databases: initialDatabases, latestVersion, oldestVersion, token };
    }
    case ActionType.NewDb: {
      const { newDb, updatedDatabases } = payload.data;
      const newSelectedDb = updatedDatabases.find((d: any) => d.alias === newDb.alias);
      const tabsCopy = [...state.editorTabs];
      tabsCopy.map(t => (t.queryRes = undefined));
      return {
        ...state,
        databases: updatedDatabases,
        selectedDb: newSelectedDb,
        newDb,
        editorTabs: tabsCopy,
      };
    }
    case ActionType.ResetNewDb: {
      return { ...state, newDb: undefined };
    }
    case ActionType.EditContent: {
      const { content: editorContent } = payload.data;
      const relevantTab = state.editorTabs[state.editorSelectedTab];
      relevantTab.content = editorContent;
      return { ...state };
    }
    case ActionType.RunningSql: {
      const { isRunning, tabIdx } = payload.data;
      const tabsCopy = [...state.editorTabs];
      tabsCopy[tabIdx].isRunning = isRunning;
      return { ...state, editorTabs: tabsCopy };
    }
    case ActionType.RunSql: {
      const { queryRes, databases: runSqlUpdatedDbs, tabIdx } = payload.data;
      const tabsCopy = [...state.editorTabs];
      tabsCopy[tabIdx].queryRes = queryRes;
      if (runSqlUpdatedDbs !== null && runSqlUpdatedDbs !== undefined) {
        const current = runSqlUpdatedDbs.find((d: any) => d.alias === state.selectedDb.alias);
        return { ...state, databases: runSqlUpdatedDbs, selectedDb: current, editorTabs: tabsCopy };
      }
      return { ...state, editorTabs: tabsCopy, forceRun: false };
    }
    case ActionType.RunAutocompleteSql: {
      const { autoCompleteRes } = payload.data;
      const moduleData = {} as {
        [moduleName: string]: {
          [tableName: string]: { [columnName: string]: string } & { recordCount: number };
        };
      };
      const allModules = {} as { [moduleName: string]: string[] };
      const functionData = {} as {
        [moduleName: string]: {
          [functionName: string]: string;
        };
      };
      (autoCompleteRes?.[0]?.result ?? []).forEach((row: any) => {
        const moduleName = row.module;
        const functionName = row.name;
        const functionSignature = row.signature;
        functionData[moduleName] = functionData[moduleName] || {};
        functionData[moduleName][functionName] = functionSignature;
      });
      (autoCompleteRes?.[1]?.result ?? []).forEach((row: any) => {
        const moduleName = row.module;
        const tableName = row.table_name;
        const columnName = row.column_name;
        const dataType = row.data_type;
        const recordCount =
          autoCompleteRes?.[3]?.result?.find((r: any) => r.table_name === tableName)?.record_count ?? 0;
        moduleData[moduleName] = moduleData[moduleName] || {};
        moduleData[moduleName][tableName] = moduleData[moduleName][tableName] || {};
        moduleData[moduleName][tableName][columnName] = dataType;
        moduleData[moduleName][tableName]['recordCount'] = recordCount;
      });
      (autoCompleteRes?.[2]?.result ?? []).forEach((row: any) => {
        const moduleName = row.module_name;
        const moduleDependencies = row.dependencies.join(', ');
        allModules[moduleName] = moduleDependencies;
      });
      return {
        ...state,
        functions: functionData,
        allModules,
        installedModules: moduleData,
      };
    }
    case ActionType.InstallModule: {
      const { moduleName: installModule } = payload.data;
      const installContent = `/* BEGIN IaSQL auto-generated statement */
SELECT * FROM iasql_install('${installModule}');
/* END IaSQL auto-generated statement */
`;
      const tabsCopy = [...state.editorTabs];
      const newTab = tabsCopy.pop();
      tabsCopy.push({ title: `Query-${state.editorTabsCreated}`, content: installContent, closable: true });
      if (newTab) tabsCopy.push(newTab);
      return { ...state, editorTabs: tabsCopy, editorTabsCreated: state.editorTabsCreated + 1 };
    }
    case ActionType.UninstallModule: {
      const { moduleName: uninstallModule } = payload.data;
      const uninstallContent = `/* BEGIN IaSQL auto-generated statement */
SELECT * FROM iasql_uninstall('${uninstallModule}');
/* END IaSQL auto-generated statement */
`;
      const tabsCopy = [...state.editorTabs];
      const newTab = tabsCopy.pop();
      tabsCopy.push({ title: `Query-${state.editorTabsCreated}`, content: uninstallContent, closable: true });
      if (newTab) tabsCopy.push(newTab);
      return { ...state, editorTabs: tabsCopy, editorTabsCreated: state.editorTabsCreated + 1 };
    }
    case ActionType.DisconnectDb: {
      const { databases: updatedDbsAfterDisconnect } = payload.data;
      const updatedSelectedDb = updatedDbsAfterDisconnect.length ? updatedDbsAfterDisconnect[0] : null;
      return {
        ...state,
        selectedDb: updatedSelectedDb,
        databases: updatedDbsAfterDisconnect,
        shouldShowDisconnect: false,
      };
    }
    case ActionType.ShowDisconnect: {
      const { show } = payload.data;
      return { ...state, shouldShowDisconnect: show };
    }
    case ActionType.ShowConnect: {
      const { showConnect } = payload.data;
      return { ...state, shouldShowConnect: showConnect };
    }
    case ActionType.ResetError: {
      return { ...state, error: null };
    }
    case ActionType.SetError: {
      const { error: customError } = payload.data;
      return { ...state, error: customError };
    }
    case ActionType.EditorNewTab: {
      const tabsCopy = [...state.editorTabs];
      const newTab = tabsCopy.pop();
      tabsCopy.push({ title: `Query-${state.editorTabsCreated}`, content: '', closable: true });
      if (newTab) tabsCopy.push(newTab);
      return { ...state, editorTabs: tabsCopy, editorTabsCreated: state.editorTabsCreated + 1 };
    }
    case ActionType.EditorSelectTab: {
      const { index } = payload.data;
      return { ...state, editorSelectedTab: index };
    }
    case ActionType.EditorCloseTab: {
      const { index } = payload.data;
      const tabsCopy = [...state.editorTabs];
      tabsCopy.splice(index, 1);
      return { ...state, editorTabs: tabsCopy };
    }
    case ActionType.SelectAppTheme: {
      const { theme } = payload.data;
      return { ...state, isDarkMode: theme === 'dark' };
    }
    case ActionType.SelectTable: {
      const { tableName } = payload.data;
      const tabsCopy = [...state.editorTabs];
      const newTab = tabsCopy.pop();
      const tabContent = `SELECT * FROM ${tableName};`;
      tabsCopy.push({ title: `Query-${state.editorTabsCreated}`, content: tabContent, closable: true });
      if (newTab) tabsCopy.push(newTab);
      return {
        ...state,
        editorTabs: tabsCopy,
        editorTabsCreated: state.editorTabsCreated + 1,
        forceRun: true,
      };
    }
  }
  return state;
};

const middlewareReducer = async (
  config: ConfigInterface,
  dispatch: (payload: Payload) => void,
  payload: Payload,
) => {
  const { token } = payload;
  const { backendUrl } = config?.engine;
  switch (payload.action) {
    case ActionType.InitialLoad: {
      try {
        const initialDatabases = await DbActions.list(token ?? '', backendUrl, config);
        const oldestVer = await DbActions.getOldestVersion(token ?? '', backendUrl);
        const latestVer = await DbActions.getLatestVersion(token ?? '', backendUrl);
        dispatch({
          ...payload,
          data: {
            initialDatabases,
            oldestVersion: oldestVer.split('-')[0],
            latestVersion: latestVer.split('-')[0],
          },
        });
        break;
      } catch (e: any) {
        const error = e.message ? e.message : `Unexpected error getting initial load`;
        dispatch({ ...payload, data: { error } });
        break;
      }
    }
    case ActionType.NewDb: {
      if (!token) {
        dispatch({ ...payload, data: { error: 'No auth token defined.' } });
        break;
      }
      const { dbAlias, awsSecretAccessKey, awsRegion, awsAccessKeyId, latestVersion } = payload.data;
      const alias = dbAlias ? dbAlias : uniqueNamesGenerator(nameGenConfig);
      let newDb: any = null;
      try {
        newDb = await DbActions.newDb(token, backendUrl, alias);
      } catch (e: any) {
        const error = e.message ? e.message : `Unexpected error connecting database ${alias}`;
        dispatch({ ...payload, data: { error } });
        break;
      }
      try {
        await DbActions.run(
          token,
          backendUrl,
          alias,
          `
          SELECT * FROM iasql_install('aws_account');
        `,
        );
      } catch (e: any) {
        const error = e.message ? e.message : `Error adding aws_account ${alias}`;
        dispatch({ ...payload, data: { error } });
        break;
      }
      // New DBs will always use the newest module conventions, so this is switched to the two
      // table aws_account form now
      // ${awsRegion.name}
      try {
        await DbActions.run(
          token,
          backendUrl,
          alias,
          `
          INSERT INTO aws_credentials (access_key_id, secret_access_key)
          VALUES ('${awsAccessKeyId}', '${awsSecretAccessKey}');
        `,
        );
        if (semver.lt(latestVersion ?? '', '0.0.23')) {
          await DbActions.run(
            token,
            backendUrl,
            alias,
            `
            SELECT * FROM iasql_sync();
          `,
          );
        } else {
          await DbActions.run(
            token,
            backendUrl,
            alias,
            `
            SELECT * FROM iasql_begin();
          `,
          );
          await DbActions.run(
            token,
            backendUrl,
            alias,
            `
            SELECT * FROM iasql_commit();
          `,
          );
        }
        await DbActions.run(
          token,
          backendUrl,
          alias,
          `
          SELECT * FROM default_aws_region('${awsRegion.name}');
        `,
        );
      } catch (e: any) {
        const error = e.message ? e.message : `Error adding credentials ${dbAlias}`;
        dispatch({ ...payload, data: { error } });
        break;
      }
      if (newDb) {
        // update the db list before hiding the modal
        const updatedDatabases = await DbActions.list(token, backendUrl, config);
        dispatch({ ...payload, data: { newDb, updatedDatabases } });
      }
      break;
    }
    case ActionType.RunSql: {
      if (!token) {
        dispatch({ ...payload, data: { error: 'No auth token defined.' } });
        break;
      }
      const { content, db: runningDb, tabIdx } = payload.data;
      if (runningDb.isUnsupported) {
        break;
      }
      let queryRes: any = 'Invalid or empty response';
      let databases: any[] | null = null;
      let shouldUpdate = false;
      let updatedAutoCompleteRes: any;
      let queryError: string = 'Unhandled error in SQL execution';
      dispatch({ action: ActionType.RunningSql, data: { isRunning: true, tabIdx } });
      try {
        if (token && content) queryRes = await DbActions.run(token, backendUrl, runningDb?.alias, content);
        const compFn = (r: any, stmt: string) =>
          r.statement && typeof r.statement === 'string' && r.statement.toLowerCase().indexOf(stmt) !== -1;
        for (const r of queryRes) {
          if (compFn(r, 'iasql_install(') || compFn(r, 'iasql_uninstall(')) shouldUpdate = true;
        }
        if (shouldUpdate) {
          databases = await DbActions.list(token, backendUrl, config);
          updatedAutoCompleteRes = await DbActions.run(
            token,
            backendUrl,
            runningDb?.alias,
            initializingQueries,
          );
        }
      } catch (e: any) {
        if (e.message) {
          queryError = e.message;
        }
        queryRes = queryError;
      }
      dispatch({ action: ActionType.RunningSql, data: { isRunning: false, tabIdx } });
      dispatch({
        action: ActionType.TrackEvent,
        data: {
          trackEventName: 'RUN_SQL',
          trackDbAlias: runningDb?.alias,
          queryToRun: content,
          queryOutput: queryRes,
          queryError,
        },
      });
      dispatch({ ...payload, data: { queryRes, databases, tabIdx } });
      if (updatedAutoCompleteRes) {
        dispatch({
          ...payload,
          action: ActionType.RunAutocompleteSql,
          data: { autoCompleteRes: updatedAutoCompleteRes },
        });
      }
      break;
    }
    case ActionType.RunAutocompleteSql: {
      if (!token) {
        dispatch({ ...payload, data: { error: 'No auth token defined.' } });
        break;
      }
      const { dbAlias: autoCompleteDbAlias } = payload.data;
      try {
        const autoCompleteRes = await DbActions.run(
          token,
          backendUrl,
          autoCompleteDbAlias,
          initializingQueries,
        );
        dispatch({ ...payload, data: { autoCompleteRes } });
      } catch (e: any) {
        const error = e.message ? e.message : `Unexpected error`;
        dispatch({ ...payload, data: { error } });
      }
      break;
    }
    case ActionType.DisconnectDb: {
      if (!token) {
        dispatch({ ...payload, data: { error: 'No auth token defined.' } });
        break;
      }
      const { dbAlias: disconnectDbAlias } = payload.data;
      try {
        await DbActions.disconnect(token, backendUrl, disconnectDbAlias);
        const afterDisconnectDbs = await DbActions.list(token, backendUrl, config);
        dispatch({ ...payload, data: { databases: afterDisconnectDbs } });
      } catch (e: any) {
        const error = e.message ? e.message : `Unexpected error disconnecting database ${disconnectDbAlias}`;
        dispatch({ ...payload, data: { error } });
      }
      break;
    }
    case ActionType.TrackEvent: {
      if (!token) {
        dispatch({ ...payload, data: { error: 'No auth token defined.' } });
        break;
      }
      const { trackEventName, trackDbAlias, buttonAlias, queryToRun, queryOutput, queryError } = payload.data;
      try {
        if (trackEventName) {
          await Posthog.capture(config, trackEventName, {
            dbAlias: trackDbAlias,
            buttonAlias,
            sql: queryToRun,
            error: queryError,
            output: queryOutput,
          });
        }
      } catch (e: any) {
        const error = e.message ? e.message : `Unexpected error`;
        dispatch({ ...payload, data: { error } });
      }
      break;
    }
    case ActionType.EditorSelectTab: {
      const { selectedDb, forceRun, index, editorTabs } = payload.data;
      const contentToBeRun = editorTabs?.[index]?.content ?? '';
      if (token && forceRun && contentToBeRun) {
        middlewareReducer(config, dispatch, {
          token,
          action: ActionType.RunSql,
          data: {
            db: selectedDb,
            content: contentToBeRun,
            tabIdx: index,
          },
        });
      }
    }
    default: {
      dispatch(payload);
    }
  }
};

const AppProvider = ({ children }: { children: any }) => {
  const { config } = useAppConfigContext();
  const initialState: AppState = {
    selectedDb: null,
    oldestVersion: undefined,
    latestVersion: undefined,
    isRunningSql: false,
    databases: [],
    error: null,
    allModules: {},
    functions: {},
    installedModules: {},
    isDarkMode: false,
    shouldShowDisconnect: false,
    shouldShowConnect: false,
    editorSelectedTab: 0,
    editorTabsCreated: 1,
    editorTabs: [
      { title: 'Welcome', content: '', closable: true },
      {
        title: '+',
        content: '',
        width: 'w-auto',
        className: 'px-4 border border-transparent',
        action: () => {
          dispatch({
            action: ActionType.EditorNewTab,
          });
        },
      },
    ],
    forceRun: false,
  };
  const [state, dispatch] = useReducer(reducer, initialState);
  const customDispatch = useCallback(
    async (payload: Payload) => {
      middlewareReducer(config, dispatch, payload);
    },
    [config],
  );

  return (
    <AppContext.Provider
      value={{
        token: state.token,
        selectedDb: state.selectedDb,
        isDarkMode: state.isDarkMode,
        databases: state.databases,
        error: state.error,
        latestVersion: state.latestVersion,
        oldestVersion: state.oldestVersion,
        newDb: state.newDb,
        allModules: state.allModules,
        functions: state.functions,
        installedModules: state.installedModules,
        isRunningSql: state.isRunningSql,
        shouldShowDisconnect: state.shouldShowDisconnect,
        shouldShowConnect: state.shouldShowConnect,
        editorTabs: state.editorTabs,
        editorSelectedTab: state.editorSelectedTab,
        editorTabsCreated: state.editorTabsCreated,
        forceRun: state.forceRun,
        dispatch: customDispatch,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export type { AppStore };
export { AppProvider, useAppContext };
