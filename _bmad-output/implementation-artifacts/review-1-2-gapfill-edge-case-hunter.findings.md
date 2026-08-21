```json
[
  {
    "location": "scripts/check-core-purity.js:203-214",
    "trigger_condition": "Math['random']() uses bracket notation instead of dot-notation property access",
    "guard_snippet": "if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) { /* check FORBIDDEN_MEMBERS */ }",
    "potential_consequence": "Randomness call slips past the purity gate undetected, breaking core determinism silently"
  },
  {
    "location": "scripts/check-core-purity.js:243-256",
    "trigger_condition": "Class or object method/accessor named like a forbidden global, e.g. process()",
    "guard_snippet": "if ((ts.isMethodDeclaration(parent)||ts.isGetAccessor(parent)||ts.isSetAccessor(parent)) && parent.name===node) return false;",
    "potential_consequence": "Legitimate method name falsely reported as forbidden-reference, breaking the build unnecessarily"
  },
  {
    "location": "scripts/check-core-purity.js:81,162",
    "trigger_condition": "Relative import specifier is bare '.' or '..' with no trailing slash",
    "guard_snippet": "const RELATIVE_SPECIFIER = /^\\.\\.?(\\/|$)/;",
    "potential_consequence": "Valid relative parent/index import wrongly flagged as non-relative-import"
  },
  {
    "location": "scripts/check-core-purity.js:101-111",
    "trigger_condition": "A symlinked .ts file or directory placed under src/lib/core",
    "guard_snippet": "else if (entry.isSymbolicLink()) { const real = statSync(full); /* handle as file or dir */ }",
    "potential_consequence": "Symlinked core file is neither walked nor checked, silently bypassing the gate"
  },
  {
    "location": "scripts/check-core-purity.js:274-275",
    "trigger_condition": "process.argv[1] is undefined or its URL fails to match import.meta.url",
    "guard_snippet": "if (invoked === undefined) { process.stderr.write('cannot verify entrypoint'); process.exitCode = 1; }",
    "potential_consequence": "Purity gate silently no-ops with exit code 0 instead of failing loudly"
  }
]
```