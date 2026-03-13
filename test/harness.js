"use strict";

const assert = require("assert");

let _passed = 0;
let _failed = 0;
let _errors = [];
const _suites = [];

function describe(name, fn) {
  _suites.push({ name, fn });
}

function test(name, fn) {
  _suites.push({ name, fn, isTest: true });
}

async function runAll() {
  for (const suite of _suites) {
    if (suite.isTest) {
      await runTest(suite.name, suite.fn);
    } else {
      console.log(`\n\x1b[1m${suite.name}\x1b[0m`);
      const prevLen = _suites.length;
      const nested = [];
      const origPush = _suites.push.bind(_suites);

      const innerSuites = [];
      const innerDescribe = (n, f) => innerSuites.push({ name: n, fn: f });
      const innerTest = (n, f) => innerSuites.push({ name: n, fn: f, isTest: true });

      suite._innerDescribe = innerDescribe;
      suite._innerTest = innerTest;

      const origGlobalTest = global._currentTest;
      const origGlobalDescribe = global._currentDescribe;
      global._currentTest = innerTest;
      global._currentDescribe = innerDescribe;
      suite.fn();
      global._currentTest = origGlobalTest;
      global._currentDescribe = origGlobalDescribe;

      for (const inner of innerSuites) {
        if (inner.isTest) {
          await runTest(inner.name, inner.fn);
        } else {
          console.log(`\n  \x1b[1m${inner.name}\x1b[0m`);
        }
      }
    }
  }

  console.log(
    `\n\x1b[1m结果: ${_passed} 通过, ${_failed} 失败\x1b[0m`
  );
  if (_errors.length) {
    console.log("\n\x1b[31m失败详情:\x1b[0m");
    for (const e of _errors) {
      console.log(`  \x1b[31m✗ ${e.name}\x1b[0m`);
      console.log(`    ${e.error}`);
    }
  }
  return { passed: _passed, failed: _failed };
}

async function runTest(name, fn) {
  try {
    await fn();
    _passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    _failed++;
    const msg = err.message || String(err);
    _errors.push({ name, error: msg });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${msg}\x1b[0m`);
  }
}

module.exports = { describe, test, runAll, assert };
