#!/usr/bin/env bash
echo "Installing dependencies..."
npm install --silent
echo "Starting MC Region Tool at http://localhost:25599"
node server.js
