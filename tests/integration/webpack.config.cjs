const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const extensionRoot = path.join(projectRoot, "Extension");

module.exports = {
  mode: "production",
  entry: path.join(__dirname, "fixtures", "dinov2TestRuntime.ts"),
  output: {
    path: path.join(projectRoot, "build", "test-runtime"),
    filename: "browser-validation-runtime.js",
    publicPath: "auto",
    clean: true
  },
  target: "web",
  resolve: {
    extensions: [".ts", ".js"],
    modules: [path.join(extensionRoot, "node_modules"), "node_modules"],
    alias: {
      "onnxruntime-web": path.join(extensionRoot, "node_modules", "onnxruntime-web", "dist", "ort.wasm.bundle.min.mjs")
    },
    fallback: { crypto: false, fs: false, path: false }
  },
  externals: { "@techstark/opencv-js": "cv" },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: path.join(extensionRoot, "node_modules", "ts-loader"),
          options: { configFile: path.join(extensionRoot, "tsconfig.json") }
        },
        exclude: /node_modules/
      }
    ]
  },
  optimization: { splitChunks: false, runtimeChunk: false },
  performance: false
};
