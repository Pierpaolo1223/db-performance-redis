/**
 * Configurazione Jest per il progetto (ESM)
 */
export default {
  testEnvironment: "node",
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "*.js",
    "!jest.config.js",
    "!coverage/**",
    "!__tests__/**",
  ],
  testMatch: [
    "**/__tests__/**/*.test.js",
  ],
  verbose: true,
  transform: {},
  moduleNameMapper: {
    "^@fastify/postgres$": "<rootDir>/__tests__/__mocks__/@fastify/postgres.js",
  },
};