const path = require('path');
const webpack = require('../node_modules/webpack');

module.exports = {
  mode: 'production',
  target: 'node25',
  entry: './src/index.ts',
  context: __dirname,
  devtool: false,
  output: {
    filename: 'server.cjs',
    path: path.resolve(__dirname, 'host-dist'),
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  module: {
    rules: [{
      test: /\.ts$/,
      use: [{ loader: require.resolve('../node_modules/ts-loader'), options: { configFile: path.resolve(__dirname, 'tsconfig.json') } }],
      exclude: /node_modules/,
    }],
  },
  externalsPresets: { node: true },
};
