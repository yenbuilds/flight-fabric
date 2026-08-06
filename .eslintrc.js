// ESLint configuration for flight-fabric
// Key rules:
// - Catch accidental process.env usage outside config.js
// - Standard JS conventions

module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    browser: true,  // For frontend files
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',  // CommonJS
  },
  plugins: ['import'],
  rules: {
    // =========================================================================
    // ARCHITECTURAL GUARDRAILS
    // =========================================================================
    
    // Prevent direct process.env access outside config.js
    // Use config.js instead: const config = require('./config');
    'no-restricted-syntax': [
      'error',
      {
        selector: 'MemberExpression[object.object.name="process"][object.property.name="env"]',
        message: 'Direct process.env access is forbidden. Use config.js: const config = require("./config");',
      },
    ],

    // Prevent Date.now() in non-utility modules (use timeSource.now())
    // Uncomment when ready to enforce:
    // 'no-restricted-properties': [
    //   'warn',
    //   {
    //     object: 'Date',
    //     property: 'now',
    //     message: 'Consider using timeSource.now() for deterministic replay.',
    //   },
    // ],

    // =========================================================================
    // CODE QUALITY
    // =========================================================================
    
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',  // We use console intentionally
    'prefer-const': 'warn',
    'no-var': 'warn',
    'eqeqeq': ['warn', 'smart'],
  },

  // Override for specific files
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'script',
      },
    },
    // Allow process.env in config/user-settings boundary files.
    {
      files: [
        'backend/core/config.js',
        'backend/core/user-settings.js',
        'backend/core/config.ts',
        'backend/core/user-settings.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
    // Allow process.env in test files
    {
      files: [
        '**/*test*.js',
        '**/*test*.ts',
        '**/test-*.js',
        '**/test-*.ts',
        'scripts/**/*.js',
        'backend/test/**/*.js',
        'backend/test/**/*.ts',
      ],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
    // Allow process.env in CLI tools that configure the environment before imports.
    {
      files: ['scripts/**/*.js'],
      rules: {
        'no-restricted-syntax': 'off',
      },
    },
  ],
};
