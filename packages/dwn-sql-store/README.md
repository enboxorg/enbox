# DWN SQL Stores

[![NPM](https://img.shields.io/npm/v/@enbox/dwn-sql-store.svg?style=flat-square&logo=npm&logoColor=FFFFFF&color=FFEC19&santize=true)](https://www.npmjs.com/package/@enbox/dwn-sql-store)
[![Build Status](https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/integrity-checks.yml?branch=main&logo=github&label=ci&logoColor=FFFFFF&style=flat-square)](https://github.com/enboxorg/enbox/actions/workflows/integrity-checks.yml)
[![Coverage](https://img.shields.io/codecov/c/gh/enboxorg/enbox/main?logo=codecov&logoColor=FFFFFF&style=flat-square&token=YI87CKF1LI)](https://codecov.io/github/enboxorg/enbox)
[![License](https://img.shields.io/npm/l/@enbox/dwn-sql-store.svg?style=flat-square&color=24f2ff&logo=apache&logoColor=FFFFFF&santize=true)](https://github.com/enboxorg/enbox/blob/main/LICENSE)
[![Chat](https://img.shields.io/badge/chat-on%20discord-7289da.svg?style=flat-square&color=9a1aff&logo=discord&logoColor=FFFFFF&sanitize=true)](https://discord.com/channels/937858703112155166/969272658501976117)


SQL backed implementations of DWN `MessageStore`, `DataStore`, and `StateIndex`. 

- [Supported DBs](#supported-dbs)
- [Installation](#installation)
- [Usage](#usage)
  - [SQLite](#sqlite)
  - [MySQL](#mysql)
  - [PostgreSQL](#postgresql)
- [Development](#development)
  - [Prerequisites](#prerequisites)
    - [`node` and `npm`](#node-and-npm)
    - [Docker](#docker)
  - [Running Tests](#running-tests)
  - [`npm` scripts](#npm-scripts)


# Supported DBs
* SQLite ✔️
* MySQL ✔️
* PostgreSQL ✔️

> NOTE:
See [SQL Dialect Variations](sql-dialect-variations) for the list of special handling to support the above SQL variations.

# Installation

```bash
npm install @enbox/dwn-sql-store
```

# Usage

## SQLite

```typescript
import Database from 'better-sqlite3';

import { Dwn } from '@enbox/dwn-sdk-js'
import { SqliteDialect, MessageStoreSql, DataStoreSql, StateIndexSql } from '@enbox/dwn-sql-store';

const sqliteDialect = new SqliteDialect({
  database: async () => new Database('dwn.sqlite', {
    fileMustExist: true,
  })
});

const messageStore = new MessageStoreSql(sqliteDialect);
const dataStore = new DataStoreSql(sqliteDialect);
const stateIndex = new StateIndexSql(sqliteDialect);

const dwn = await Dwn.create({ messageStore, dataStore, stateIndex });
```

## MySQL

```typescript
import { createPool } from 'mysql2';
import { Dwn } from '@enbox/dwn-sdk-js'
import { MysqlDialect, MessageStoreSql, DataStoreSql, StateIndexSql } from '@enbox/dwn-sql-store';

const mysqlDialect = new MysqlDialect({
  pool: async () => createPool({
    host     : 'localhost',
    port     : 3306,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  })
});

const messageStore = new MessageStoreSql(mysqlDialect);
const dataStore = new DataStoreSql(mysqlDialect);
const stateIndex = new StateIndexSql(mysqlDialect);

const dwn = await Dwn.create({ messageStore, dataStore, stateIndex });
```

## PostgreSQL

NOTE: PostgreSQL requires setting the `LC_COLLATE` and `LC_CTYPE`to `C` during database creation.
examples:

When using `docker` include the following option
```
POSTGRES_INITDB_ARGS='--lc-collate=C --lc-ctype=C'
```

Or when creating the database.
```
CREATE DATABASE dwn_data_store_dev
  WITH ENCODING='UTF8'
  ...
       LC_COLLATE='C'
       LC_CTYPE='C'
  ...

```


```typescript
import pg from 'pg';
import Cursor from 'pg-cursor';

import { Dwn } from '@enbox/dwn-sdk-js'
import { PostgresDialect, MessageStoreSql, DataStoreSql, StateIndexSql } from '@enbox/dwn-sql-store';

const postgresDialect = new PostgresDialect({
  pool: async () => new pg.Pool({
    host     : 'localhost',
    port     : 5432,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  }),
  cursor: Cursor
});

const messageStore = new MessageStoreSql(postgresDialect);
const dataStore = new DataStoreSql(postgresDialect);
const stateIndex = new StateIndexSql(postgresDialect);

const dwn = await Dwn.create({ messageStore, dataStore, stateIndex });
```

# Development

## Prerequisites
### `node` and `npm`
This project is developed and tested with [Node.js](https://nodejs.org/en/about/previous-releases)
`v18` and `v20` and NPM `v9`. You can verify your `node` and `npm` installation via the terminal:

```
$ node --version
v20.3.0
$ npm --version
9.6.7
```

If you don't have `node` installed. Feel free to choose whichever approach you feel the most comfortable with. If you don't have a preferred installation method, i'd recommend using `nvm` (aka node version manager). `nvm` allows you to install and use different versions of node. It can be installed by running `brew install nvm` (assuming that you have homebrew)

Once you have installed `nvm`, install the desired node version with `nvm install vX.Y.Z`.

### Docker
Docker is used to spin up a local containerized DBs for testing purposes. Docker from [here](https://docs.docker.com/engine/install/)

## Running Tests
> 💡 Make sure you have all the [prerequisites](#prerequisites)

0. clone the repo and `cd` into the project directory
1. Install all project dependencies by running `npm install`
2. Start docker
   > NOTE: You might need to delete the existing PostgreSQL and MySQL docker containers as well as `dwn.sqlite` file when a breaking change is introduced if you see tests that used to pass is now failing after a `git pull`. You can run `./scripts/delete-databases` to do this.
3. start the test databases using `./scripts/start-databases` (requires Docker)
4. run tests using `npm run test`

## `npm` scripts

| Script                  | Description                                 |
| ----------------------- | ------------------------------------------- |
| `npm run build:cjs`     | compiles typescript into CommonJS           |
| `npm run build:esm`     | compiles typescript into ESM JS             |
| `npm run build`         | compiles typescript into ESM JS & CommonJS  |
| `npm run clean`         | deletes compiled JS                         |
| `npm run test`          | runs tests.                                 |
| `npm run test-coverage` | runs tests and includes coverage            |
| `npm run lint`          | runs linter                                 |
| `npm run lint:fix`      | runs linter and fixes auto-fixable problems |

[codeowners-link]: https://github.com/enboxorg/enbox/blob/main/sql-dialect-variations.md