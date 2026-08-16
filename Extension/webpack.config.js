const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const buildRoot = path.join(projectRoot, "build", "extension");
const modelCacheRoot = path.join(projectRoot, "Models", "downloads");
const thirdPartyLicenseRoot = path.join(projectRoot, "third_party_licenses");
const releaseLayout = require(path.join(projectRoot, "scripts", "release-files.json"));
const OPENCV_MODIFICATION_NOTICE = `/*
 * Modified by the Yodel Phish project for browser-extension Content Security
 * Policy compatibility. See THIRD_PARTY_NOTICES.md. The original OpenCV.js
 * work is licensed under the Apache License 2.0.
 */
`;

function dependencyPath(relativePath) {
  const resolved = path.resolve(__dirname, "node_modules", relativePath);
  if (!fs.existsSync(resolved)) throw new Error(`Missing dependency ${relativePath}; run npm ci in Extension first`);
  return resolved;
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required build input is missing: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyMatching(sourceDir, destinationDir, pattern) {
  if (!fs.existsSync(sourceDir)) throw new Error(`Required dependency directory is missing: ${sourceDir}`);
  let copied = 0;
  for (const filename of fs.readdirSync(sourceDir)) {
    if (pattern.test(filename)) {
      copyFile(path.join(sourceDir, filename), path.join(destinationDir, filename));
      copied += 1;
    }
  }
  if (copied === 0) throw new Error(`No files in ${sourceDir} matched ${pattern}`);
}

function replaceSection(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`OpenCV CSP patch marker missing: ${startMarker}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function copyCspCompatibleOpenCv(source, destination) {
  let code = fs.readFileSync(source, "utf8");
  code = replaceSection(code, "function createNamedFunction(name,body){", "function extendError", "function createNamedFunction(name,body){return function(){return body.apply(this,arguments)}}");
  code = replaceSection(code, "function makeDynCaller(dynCall){", "var fp;", "function makeDynCaller(dynCall){switch(signature.length-1){case 0:return function(){return dynCall(rawFunction)};case 1:return function(a1){return dynCall(rawFunction,a1)};case 2:return function(a1,a2){return dynCall(rawFunction,a1,a2)};case 3:return function(a1,a2,a3){return dynCall(rawFunction,a1,a2,a3)};case 4:return function(a1,a2,a3,a4){return dynCall(rawFunction,a1,a2,a3,a4)};case 5:return function(a1,a2,a3,a4,a5){return dynCall(rawFunction,a1,a2,a3,a4,a5)};case 6:return function(a1,a2,a3,a4,a5,a6){return dynCall(rawFunction,a1,a2,a3,a4,a5,a6)};case 7:return function(a1,a2,a3,a4,a5,a6,a7){return dynCall(rawFunction,a1,a2,a3,a4,a5,a6,a7)};case 8:return function(a1,a2,a3,a4,a5,a6,a7,a8){return dynCall(rawFunction,a1,a2,a3,a4,a5,a6,a7,a8)};default:return function(){var args=[rawFunction];for(var i=0;i<arguments.length;i+=1){args.push(arguments[i])}return dynCall.apply(null,args)}}}");
  code = replaceSection(code, "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){", "function heap32VectorToArray", "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError(\"argTypes array size mismatch! Must at least get return value and 'this' types!\")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!==\"void\";return function(){if(arguments.length!==argCount-2){throwBindingError(\"function \"+humanName+\" called with \"+arguments.length+\" arguments, expected \"+(argCount-2)+\" args!\")}var destructors=needsDestructorStack?[]:null;var wired=[];var thisWired;if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired)}for(var i=0;i<argCount-2;++i){wired.push(argTypes[i+2].toWireType(destructors,arguments[i]))}var rv=cppInvokerFunc.apply(null,[cppTargetFunc].concat(wired));if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){var value=i===1?thisWired:wired[(isClassMethodFunc?1:0)+i-2];argTypes[i].destructorFunction(value)}}}if(returns){return argTypes[0].fromWireType(rv)}}}");
  code = replaceSection(code, "function __emval_get_method_caller(argCount,argTypes){", "function __emval_get_property", "function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var values=[];var offset=0;for(var i=0;i<argCount-1;++i){values.push(types[i+1].readValueFromPointer(args+offset));offset+=types[i+1].argPackAdvance}var rv=handle[name].apply(handle,values);for(var i=0;i<argCount-1;++i){if(types[i+1].deleteObject){types[i+1].deleteObject(values[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};return __emval_addMethodCaller(invokerFunction)}");
  code = OPENCV_MODIFICATION_NOTICE + code;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, code);
}

function copyStaticExtensionFiles() {
  for (const relativePath of releaseLayout.staticFiles) copyFile(path.join(__dirname, relativePath), path.join(buildRoot, relativePath));
  copyFile(path.join(projectRoot, "LICENSE"), path.join(buildRoot, "LICENSE"));
  copyFile(path.join(projectRoot, "NOTICE"), path.join(buildRoot, "NOTICE"));
  copyFile(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"), path.join(buildRoot, "THIRD_PARTY_NOTICES.md"));
  for (const entry of fs.readdirSync(thirdPartyLicenseRoot, { withFileTypes: true })) {
    if (entry.isFile()) copyFile(path.join(thirdPartyLicenseRoot, entry.name), path.join(buildRoot, "third_party_licenses", entry.name));
  }
}

class CopyRuntimeAssetsPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap("CopyRuntimeAssetsPlugin", () => {
      copyStaticExtensionFiles();
      copyFile(path.join(modelCacheRoot, "yolo-logo.onnx"), path.join(buildRoot, "models", "yolo-logo.onnx"));
      copyFile(path.join(modelCacheRoot, "dinov2_vits14.onnx"), path.join(buildRoot, "models", "dinov2_vits14.onnx"));
      copyFile(path.join(projectRoot, "Models", "dinov2_vits14_config.json"), path.join(buildRoot, "models", "dinov2_vits14_config.json"));
      copyCspCompatibleOpenCv(dependencyPath("@techstark/opencv-js/dist/opencv.js"), path.join(buildRoot, "opencv", "opencv.js"));
      copyFile(dependencyPath("tesseract.js/dist/worker.min.js"), path.join(buildRoot, "tesseract", "worker.min.js"));
      copyFile(dependencyPath("tesseract.js/dist/worker.min.js.LICENSE.txt"), path.join(buildRoot, "tesseract", "worker.min.js.LICENSE.txt"));
      copyMatching(dependencyPath("tesseract.js-core"), path.join(buildRoot, "tesseract", "core"), /^tesseract-core.*\.(?:js|wasm)$/);
      copyFile(path.join(modelCacheRoot, "eng.traineddata"), path.join(buildRoot, "tesseract", "lang", "eng.traineddata"));
      copyMatching(dependencyPath("onnxruntime-web/dist"), path.join(buildRoot, "ort-wasm"), /^ort-wasm.*\.(?:mjs|wasm)$/);
    });
  }
}

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(buildRoot, "dist"), { recursive: true });

const tsRule = {
  test: /\.ts$/,
  use: { loader: dependencyPath("ts-loader"), options: { configFile: path.resolve(__dirname, "tsconfig.json"), transpileOnly: true } },
  exclude: /node_modules/
};

const shared = {
  mode: "production",
  output: { path: path.join(buildRoot, "dist"), filename: "[name].js", clean: false },
  resolve: {
    extensions: [".ts", ".js"],
    modules: [path.resolve(__dirname, "node_modules"), "node_modules"],
    fallback: { crypto: false, fs: false, path: false }
  },
  module: { rules: [tsRule] },
  optimization: { splitChunks: false, runtimeChunk: false },
  performance: false
};

module.exports = [
  { ...shared, name: "service-worker", entry: { service_worker: "./background/service_worker.js" }, target: "webworker" },
  {
    ...shared,
    name: "offscreen-runtime",
    entry: { offscreen: "./runtime/offscreen.js" },
    target: "web",
    resolve: { ...shared.resolve, alias: { "onnxruntime-web": dependencyPath("onnxruntime-web/dist/ort.wasm.bundle.min.mjs") } },
    externals: { "@techstark/opencv-js": "cv" },
    plugins: [new CopyRuntimeAssetsPlugin()]
  },
  {
    ...shared,
    name: "inference-worker",
    entry: { inference_worker: "./runtime/inference-worker.js" },
    target: "webworker",
    // The runtime sets env.wasm.wasmPaths to the packaged /ort-wasm directory;
    // use the external-WASM entrypoint so Webpack does not emit a second 12 MB
    // copy beside the Worker bundle.
    resolve: { ...shared.resolve, alias: { "onnxruntime-web": dependencyPath("onnxruntime-web/dist/ort.wasm.min.mjs") } },
    externals: { "@techstark/opencv-js": "cv" }
  }
];
