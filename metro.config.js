const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Add @/* path alias support for Metro bundler
config.resolver.alias = {
  ...config.resolver.alias,
  '@': path.resolve(__dirname),
};

module.exports = config;