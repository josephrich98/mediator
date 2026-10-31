# todo

A tiny file-backed todo CLI with no dependencies.

## Usage

```
node src/cli.js add "buy milk"
node src/cli.js list
node src/cli.js done 1
node src/cli.js rm 1
```

Todos are stored in `./todos.json` (override with `--file <path>` or `TODO_FILE`).

## Development

```
npm test
```

## Data model

Each todo is `{ id, text, done, createdAt }`.
