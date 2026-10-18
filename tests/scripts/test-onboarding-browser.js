#!/usr/bin/env node
'use strict';
// Reuse the application fixture and native Electron input harness in a fresh
// process so this focused flow does not consume the main layout suite's budget.
process.env.FF_ONBOARDING_ONLY = '1';
require('./test-app-workbench-browser.js');
