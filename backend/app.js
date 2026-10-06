'use strict';
const path = require('path');
const express = require('express');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '50kb' }));

// API: never cache, basic hardening headers.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/api', routes);
app.use('/api', notFound);

// Frontend (static pages).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use(errorHandler);

module.exports = app;
