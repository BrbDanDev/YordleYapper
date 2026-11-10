const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

// Load .env if present (fall back to empty strings)
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  entry: {
    background: './src/background/background.ts',
    overlay: './src/overlay/overlay.ts',
    scanner: './src/scanner/scanner.ts',
    speakers: './src/speakers/speakers.ts',
    chaos: './src/chaos/chaos.ts',
    recap: './src/recap/recap.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: '[name]/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  plugins: [
    new webpack.DefinePlugin({
      __PROXCHAT_SERVER__: JSON.stringify(process.env.PROXCHAT_SERVER || 'https://proxchat.dant123.com'),
    }),
    new CopyPlugin({
      patterns: [
        { from: 'icons', to: 'icons' },
        { from: 'src/background/background.html', to: 'background/' },
        { from: 'src/overlay/overlay.html', to: 'overlay/' },
        { from: 'src/overlay/overlay.css', to: 'overlay/' },
        { from: 'src/brand/yordle-yapper.svg', to: 'brand/' },
        { from: 'src/scanner/scanner.html', to: 'scanner/' },
        { from: 'src/scanner/scanner.css', to: 'scanner/' },
        { from: 'src/speakers/speakers.html', to: 'speakers/' },
        { from: 'src/speakers/speakers.css', to: 'speakers/' },
        { from: 'src/chaos/chaos.html', to: 'chaos/' },
        { from: 'src/chaos/chaos.css', to: 'chaos/' },
        { from: 'src/recap/recap.html', to: 'recap/' },
        { from: 'src/recap/recap.css', to: 'recap/' },
        // Champion classifier model + labels
        { from: 'models/champion_classifier.onnx', to: 'models/' },
        { from: 'models/champion_labels.json', to: 'models/' },
        // ONNX Runtime WASM + MJS loader files (both required for WASM backend)
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm', to: 'background/[name][ext]' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs', to: 'background/[name][ext]' },
      ],
    }),
  ],
};
