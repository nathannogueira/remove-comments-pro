# ✨ Remove Comments

> **Remove all comments from your code instantly right from the editor context menu or Command Palette.**

**Remove Comments** strips single-line, multi-line, and block comments from 60+ programming languages while keeping your strings, logic, and file structure completely intact. Features a live diff **preview** before removing anything. Perfect for cleaning up code before sharing, shipping, or reviewing.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🗑️ **Remove All Comments** | Strip every comment in the file in one shot |
| ➖ **Single Line Only** | Remove only `//`-style inline comments |
| 📦 **Block Comments Only** | Remove only `/* */`-style multi-line comments |
| 🔍 **Remove by Prefix** | Remove only comments that start with specific text (e.g. `TODO`, `HACK`) |
| 👁️ **Preview Diff** | See exactly what will be removed before committing — no surprises |
| 🌐 **Workspace-Wide** | Remove or preview comments across every file in your project at once |
| 🔒 **Retain Rules** | Define regex patterns for comments that should never be removed |
| 📄 **Capture Strings** | Extract all string literals to a separate file |
| 🧬 **JSDoc Control** | Choose whether `/** */` JSDoc blocks are treated as comments or documentation |
| 📐 **Blank Line Trimming** | Automatically clean up empty lines left behind after removal |

---

## 🚀 Usage

### Via Editor Title Button

Click the **✨ Remove Comments** button in the editor title bar (top-right area) to access all commands without opening the context menu.

### Via Right-Click Menu

Right-click anywhere in the editor → **Remove Comments ✨** → choose an action.

### Via Command Palette

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type **Comments**.

### Available Commands

| Command | Description |
|---|---|
| `Comments: Remove All Comments (Current File)` | Removes all single-line and block comments |
| `Comments: Remove All Single Line Comments (Current File)` | Removes only inline comments (`//`, `#`, `--`, etc.) |
| `Comments: Remove All Multiline Comments (Current File)` | Removes only block comments (`/* */`, `<!-- -->`, etc.) |
| `Comments: Remove All Comments with Prefix (Current File)` | Prompts for a prefix and removes only matching comments |
| `Comments: Remove All Comments (Workspace)` | Removes all comments from every file in the workspace |
| `Comments: Preview: Remove All Comments (Current File)` | Opens a diff view — see what would be removed first |
| `Comments: Preview: Remove All Single Line Comments (Current File)` | Preview of inline-only removal |
| `Comments: Preview: Remove All Multiline Comments (Current File)` | Preview of block-only removal |
| `Comments: Preview: Remove All Comments (Workspace)` | Shows a summary of all comments found across the workspace |
| `Comments: Extract Strings to a file` | Writes all string literals to an output file |
| `Comments: Mark JSDOC String as comment. For next removal only.` | Toggles the `treatJsdocAsComment` setting |
| `Comments: Ignore any "remove-comments.keep" setting. For next removal only.` | Toggles the `bypassRetainRules` setting |

> 💡 **Tip:** Select text before running any command to process only the selected region.

---

## 👁️ Preview Mode

By default, **Remove Comments** shows a diff preview before making any changes. Run any removal command and VS Code opens its native diff editor — left side is your original file, right side is the result after removal. Lines that would be deleted appear highlighted in red. A prompt lets you **Apply** or **Cancel**.

To skip the confirmation step and apply changes immediately, set:
```json
"remove-comments.previewBeforeApply": false
```

You can also run any **Preview:** command explicitly to open the diff without triggering removal.

---

## ⚙️ Settings

Configure **Remove Comments** in VS Code settings (`Ctrl+,`), search for `remove-comments`:

### `remove-comments.previewBeforeApply`
- **Type:** `boolean` · **Default:** `true`
- Show a diff preview and ask for confirmation before applying any comment removal. Set to `false` to apply immediately.

### `remove-comments.enableC99`
- **Type:** `boolean` · **Default:** `false`
- Enable `//` comments in C files (C99 and later standard).

### `remove-comments.trimBlankLines.above`
- **Type:** `integer` · **Default:** `0`
- After removing a comment, also delete up to N blank lines **above** it.

### `remove-comments.trimBlankLines.below`
- **Type:** `integer` · **Default:** `0`
- After removing a comment, also delete up to N blank lines **below** it.

### `remove-comments.treatJsdocAsComment`
- **Type:** `boolean` · **Default:** `false`
- Treat `/** */` JSDoc blocks as comments and remove them. When `false` (default), JSDoc blocks are preserved as documentation.

### `remove-comments.bypassRetainRules`
- **Type:** `boolean` · **Default:** `false`
- Ignore all retain rules and remove every comment, including ones protected by regex patterns. When `false` (default), retain rules are respected.

### `remove-comments.stringCapture.outputPath`
- **Type:** `string`
- Absolute path to the file where captured strings will be appended.  
  ⚠️ The file must be open in a tab before running **Extract Strings to a file**.

### `remove-comments.stringCapture.lineGlue`
- **Type:** `string` · **Default:** `"@@@@"`
- Replacement for newlines inside multi-line strings when capturing.

### `remove-comments.retain`
- **Type:** `object | false`
- Define named regex rules for comments that should **not** be removed.  
  Use the language ID (e.g. `"javascript"`, `"python"`) or `"all"` as the key.

**Example — keep any comment containing `@license` or `@preserve`:**
```json
"remove-comments.retain": {
  "all": {
    "license": { "regex": "@license|@preserve", "flags": "i" }
  }
}
```

**Example — keep TODO comments only in Python:**
```json
"remove-comments.retain": {
  "python": {
    "todos": { "regex": "TODO", "flags": "i" }
  }
}
```

Set to `false` to disable all retain rules globally:
```json
"remove-comments.retain": false
```

---

## 🌐 Supported Languages

**Remove Comments** supports **60+ languages** out of the box:

| Category | Languages |
|---|---|
| **Web** | JavaScript, TypeScript, JSX, TSX, CSS, SCSS, LESS, Sass, Stylus, HTML, Vue, Svelte, XML, GraphQL, JSON with Comments |
| **Systems** | C, C++, Rust, Go, Zig, Verilog, SystemVerilog |
| **JVM** | Java, Kotlin, Scala, Groovy |
| **Scripting** | Python, Ruby, Perl, Perl 6 (Raku), Lua, CoffeeScript |
| **Shell** | Bash/Shell, PowerShell, Dockerfile, Makefile |
| **Functional** | Haskell, F#, Erlang, Elixir, Clojure, Lisp, Racket, Scheme |
| **Data / Query** | SQL, PL/SQL, YAML, TOML, Terraform, Properties/INI |
| **Other** | PHP, Blade, Swift, Dart, Haxe, Pascal, Ada, VHDL, COBOL, LaTeX, Julia, R, VB, Pug/Jade, AL, CFML, Solidity, Uiua |

---

## 🔬 Advanced: Multi-Language Files

**Remove Comments** automatically splits multi-language files into zones and applies the correct comment rules for each section:

- **HTML / Svelte** → HTML body + `<style>` (CSS) + `<script>` (JavaScript)
- **Vue** → `<template>`, `<script>`, `<style>` — each with their own language (respects `lang="ts"`, `lang="scss"`, etc.)
- **PHP** → only processes code inside `<?php ... ?>` blocks

---

## 📋 Examples

**Before:**
```javascript
// Initialize the application
const app = express(); /* legacy framework */

/**
 * @param {string} name
 */
function greet(name) {
  // TODO: add i18n support
  return `Hello, ${name}!`; // greeting
}
```

**After `Remove All Comments (Current File)`:**
```javascript
const app = express();

function greet(name) {
  return `Hello, ${name}!`;
}
```

**After `Remove All Single Line Comments (Current File)`:**
```javascript
const app = express(); /* legacy framework */

/**
 * @param {string} name
 */
function greet(name) {
  return `Hello, ${name}!`;
}
```

---

## 📝 License

MIT © Remove Comments Contributors
