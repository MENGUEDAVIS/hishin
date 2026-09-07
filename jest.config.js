export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {},
  clearMocks: true,
  collectCoverageFrom: ['src/pipeline/**/*.js', 'src/media/**/*.js'],
  coverageDirectory: 'coverage',
};
