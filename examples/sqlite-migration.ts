// Example: Migrating from better-sqlite3 to bun:sqlite

// ===== BEFORE: Using better-sqlite3 =====
// import Database from 'better-sqlite3';
// 
// const db = new Database('mydb.sqlite', { 
//   readonly: false,
//   fileMustExist: false,
//   timeout: 5000,
//   verbose: console.log
// });
// 
// // Prepare statements
// const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
// const selectAll = db.prepare('SELECT * FROM users');
// const selectOne = db.prepare('SELECT * FROM users WHERE id = ?');
// 
// // Execute queries
// const info = insert.run('John Doe', 'john@example.com');
// console.log(info.lastInsertRowid);
// 
// const users = selectAll.all();
// const user = selectOne.get(1);
// 
// // Transactions
// const insertMany = db.transaction((users) => {
//   for (const user of users) {
//     insert.run(user.name, user.email);
//   }
// });
// 
// insertMany([
//   { name: 'Alice', email: 'alice@example.com' },
//   { name: 'Bob', email: 'bob@example.com' }
// ]);
// 
// db.close();

// ===== AFTER: Using bun:sqlite =====
import { Database } from 'bun:sqlite';

// Open database (API is almost identical!)
const db = new Database('mydb.sqlite', { 
  readonly: false,
  create: true  // replaces fileMustExist: false
});

// Create table
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  )
`);

// Prepare statements (identical API)
const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
const selectAll = db.prepare('SELECT * FROM users');
const selectOne = db.prepare('SELECT * FROM users WHERE id = ?');

// Execute queries (almost identical, slight return value differences)
const result = insert.run('John Doe', 'john@example.com');
console.log(result.lastInsertRowid); // Note: property name is same

const users = selectAll.all();
const user = selectOne.get(1);

// Transactions (identical API)
const insertMany = db.transaction((users) => {
  for (const user of users) {
    insert.run(user.name, user.email);
  }
});

insertMany([
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' }
]);

// Using named parameters (both support this)
const insertNamed = db.prepare('INSERT INTO users (name, email) VALUES ($name, $email)');
insertNamed.run({ $name: 'Charlie', $email: 'charlie@example.com' });

// Bun-specific features

// 1. Built-in serialization
const serialized = db.serialize(); // Returns Uint8Array
const newDb = Database.deserialize(serialized);

// 2. Using statement
{
  using db = new Database(':memory:');
  using query = db.prepare('SELECT 1 + 1 as result');
  console.log(query.get()); // { result: 2 }
} // Automatically closed

// 3. Iterator support (new in Bun v1.1.31)
const query = db.prepare('SELECT * FROM users');
for (const row of query.iterate()) {
  console.log(row);
}

// 4. Map results to classes
class User {
  id!: number;
  name!: string;
  email!: string;

  get displayName() {
    return `${this.name} <${this.email}>`;
  }
}

const usersAsClass = db.prepare('SELECT * FROM users').all().map(row => Object.assign(new User(), row));
// Or use the new .as() method
const usersQuery = db.prepare('SELECT * FROM users').as(User);
const userInstances = usersQuery.all();
console.log(userInstances[0].displayName);

// Close database
db.close();

// Performance notes:
// - bun:sqlite is 3-6x faster than better-sqlite3 for reads
// - 8-9x faster than deno.land/x/sqlite
// - No native module compilation needed
// - Works immediately after bun install