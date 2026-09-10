'use strict';

// Keep the real named-pipe mutex, but give this test family its own account
// identity so it can exercise ownership while the desktop app is running.
const os = require('node:os');
const username = process.env.FF_RUNTIME_LOCK_TEST_USERNAME;
if (!username) throw new Error('Runtime lock test identity is required');
const userInfo = os.userInfo;
os.userInfo = (...args) => ({ ...userInfo(...args), username });
