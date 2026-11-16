'use strict';

/**
 * Vercel Serverless Function Entrypoint
 * Wraps the Express application exported by ../server.js
 */
const serverModule = require('../server');

const app =
  typeof serverModule === 'function'
    ? serverModule
    : serverModule && (serverModule.app || serverModule.default);

if (!app) {
  throw new Error('Failed to load Express app instance from ../server.js');
}

module.exports = app;
