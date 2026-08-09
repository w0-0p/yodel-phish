#!/usr/bin/env python3
"""
Export the official Meta DINOv2 ViT-S/14 (no registers) backbone to ONNX.

Only the final normalized CLS token (x_norm_clstoken, 384 values) is exported.
No patch tokens, register tokens, or classifier head are exposed.

Prerequisites:
  pip install torch torchvision onnx onnxruntime

Usage:
  python3 tools/model-export/export_dinov2_vits14_onnx.py [--output-dir Models/downloads]
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DINOV2_REPO = "facebookresearch/dinov2"
DINOV2_REVISION = "7764ea0f912e53c92e82eb78a2a1631e92725fc8"
MODEL_NAME = "dinov2_vits14"
CHECKPOINT_URL = "https://dl.fbaipublicfiles.com/dinov2/dinov2_vits14/dinov2_vits14_pretrain.pth"
EXPORTER_VERSION = "1.0.0"
OPSET = 17
EMBEDDING_DIM = 384
CROP_SIZE = 224


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def npm_package_version(package_json: Path) -> str | None:
    if not package_json.exists():
        return None
    try:
        value = json.loads(package_json.read_text()).get("version")
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, str) else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Export DINOv2 ViT-S/14 backbone to ONNX")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[2] / "Models" / "downloads"),
        help="Directory to write ONNX, config, and provenance files",
    )
    args = parser.parse_args()

    try:
        import torch
        import torch.nn as nn
    except ImportError as exc:
        sys.exit(f"Missing dependency: {exc}\nInstall with: pip install torch torchvision onnx onnxruntime")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    torch_version = torch.__version__
    print(f"torch {torch_version}", flush=True)

    # DINOv2's MemEffAttention checks this before importing xFormers. Keeping the
    # standard PyTorch scaled-dot-product path makes the exported graph portable to
    # ONNX Runtime Web/WASM even when xFormers happens to be installed locally.
    os.environ["XFORMERS_DISABLED"] = "1"
    pinned_repository = f"{DINOV2_REPO}:{DINOV2_REVISION}"
    print(f"Loading {MODEL_NAME} from {pinned_repository}...", flush=True)
    backbone = torch.hub.load(pinned_repository, MODEL_NAME, pretrained=True, trust_repo=True)
    backbone = backbone.eval()

    class ClsTokenWrapper(nn.Module):
        def __init__(self, model: nn.Module) -> None:
            super().__init__()
            self.model = model

        def forward(self, pixel_values: "torch.Tensor") -> "torch.Tensor":
            features = self.model.forward_features(pixel_values)
            cls_descriptor = features["x_norm_clstoken"]
            # Make the non-batch output dimension explicit in the ONNX graph rather
            # than leaving it as a symbolic Gather result.
            return cls_descriptor.reshape(pixel_values.shape[0], EMBEDDING_DIM)

    wrapper = ClsTokenWrapper(backbone).eval()

    dummy = torch.zeros(1, 3, CROP_SIZE, CROP_SIZE)
    with torch.no_grad():
        sample_output = wrapper(dummy)
    if tuple(sample_output.shape) != (1, EMBEDDING_DIM):
        sys.exit(f"Unexpected wrapper output shape {tuple(sample_output.shape)}, expected (1, {EMBEDDING_DIM})")
    print(f"Wrapper output shape verified: {tuple(sample_output.shape)}", flush=True)

    onnx_path = output_dir / "dinov2_vits14.onnx"
    print(f"Exporting to {onnx_path} (opset {OPSET})...", flush=True)
    export_command = (
        f"torch.onnx.export(wrapper, dummy, '{onnx_path.name}', "
        f"input_names=['pixel_values'], output_names=['image_features'], "
        f"dynamic_axes={{'pixel_values': {{0: 'batch_size'}}, 'image_features': {{0: 'batch_size'}}}}, "
        f"opset_version={OPSET}, do_constant_folding=True)"
    )
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            dummy,
            str(onnx_path),
            dynamo=False,
            input_names=["pixel_values"],
            output_names=["image_features"],
            dynamic_axes={
                "pixel_values": {0: "batch_size"},
                "image_features": {0: "batch_size"},
            },
            opset_version=OPSET,
            do_constant_folding=True,
        )
    size_mb = onnx_path.stat().st_size / 1_000_000
    print(f"Exported: {onnx_path} ({size_mb:.1f} MB)", flush=True)

    print("Verifying exported model contract and onnxruntime execution...", flush=True)
    import onnx
    import onnxruntime as ort

    onnx_model = onnx.load(str(onnx_path), load_external_data=False)
    onnx.checker.check_model(onnx_model)
    default_opsets = [item.version for item in onnx_model.opset_import if item.domain in ("", "ai.onnx")]
    if default_opsets != [OPSET]:
        sys.exit(f"Unexpected ONNX opset imports: {default_opsets}, expected [{OPSET}]")
    if len(onnx_model.graph.input) != 1 or len(onnx_model.graph.output) != 1:
        sys.exit(
            f"Unexpected graph I/O count: {len(onnx_model.graph.input)} inputs, "
            f"{len(onnx_model.graph.output)} outputs; expected exactly one of each"
        )

    graph_input = onnx_model.graph.input[0]
    graph_output = onnx_model.graph.output[0]
    if graph_input.name != "pixel_values" or graph_output.name != "image_features":
        sys.exit(f"Unexpected graph I/O names: input={graph_input.name} output={graph_output.name}")
    if graph_input.type.tensor_type.elem_type != onnx.TensorProto.FLOAT:
        sys.exit("ONNX input pixel_values is not float32")
    if graph_output.type.tensor_type.elem_type != onnx.TensorProto.FLOAT:
        sys.exit("ONNX output image_features is not float32")

    input_dims = graph_input.type.tensor_type.shape.dim
    output_dims = graph_output.type.tensor_type.shape.dim
    input_shape = [dim.dim_param or dim.dim_value for dim in input_dims]
    output_shape = [dim.dim_param or dim.dim_value for dim in output_dims]
    if len(input_dims) != 4 or not input_dims[0].dim_param or input_shape[1:] != [3, CROP_SIZE, CROP_SIZE]:
        sys.exit(f"ONNX input shape is {input_shape}, expected [dynamic_batch, 3, 224, 224]")
    if len(output_dims) != 2 or not output_dims[0].dim_param or output_shape[1:] != [EMBEDDING_DIM]:
        sys.exit(f"ONNX output shape is {output_shape}, expected [dynamic_batch, {EMBEDDING_DIM}]")

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    if len(session.get_inputs()) != 1 or len(session.get_outputs()) != 1:
        sys.exit("ONNX Runtime did not expose exactly one input and one output")
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    if input_meta.name != "pixel_values":
        sys.exit(f"Unexpected input name: {input_meta.name}")
    if output_meta.name != "image_features":
        sys.exit(f"Unexpected output name: {output_meta.name}")
    if input_meta.type != "tensor(float)" or output_meta.type != "tensor(float)":
        sys.exit(f"Unexpected ONNX Runtime I/O types: input={input_meta.type} output={output_meta.type}")
    if input_meta.shape[1:] != [3, CROP_SIZE, CROP_SIZE] or output_meta.shape[1:] != [EMBEDDING_DIM]:
        sys.exit(f"Unexpected ONNX Runtime I/O shapes: input={input_meta.shape} output={output_meta.shape}")

    import numpy as np

    verify_input = np.zeros((2, 3, CROP_SIZE, CROP_SIZE), dtype=np.float32)
    (verify_output,) = session.run(["image_features"], {"pixel_values": verify_input})
    if verify_output.shape != (2, EMBEDDING_DIM):
        sys.exit(f"Unexpected ONNX output shape {verify_output.shape}, expected (2, {EMBEDDING_DIM})")
    if not np.isfinite(verify_output).all():
        sys.exit("ONNX output contains non-finite values")
    print(f"ONNX verification passed: input={input_meta.name} output={output_meta.name} shape={verify_output.shape}", flush=True)

    config = {
        "resizeSize": 256,
        "cropSize": CROP_SIZE,
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225],
        "inputName": "pixel_values",
        "outputName": "image_features",
        "embeddingDimension": EMBEDDING_DIM,
    }
    config_path = output_dir / "dinov2_vits14_config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"Config: {config_path}", flush=True)

    print("Recording checkpoint SHA-256 from the torch hub cache...", flush=True)
    checkpoint_cache = Path(torch.hub.get_dir()) / "checkpoints" / "dinov2_vits14_pretrain.pth"
    checkpoint_sha256 = sha256_of(checkpoint_cache) if checkpoint_cache.exists() else None
    if checkpoint_sha256 is None:
        print(f"WARNING: checkpoint cache file not found at {checkpoint_cache}; provenance metadata will omit checkpoint SHA-256.", flush=True)

    try:
        torchvision_version = __import__("torchvision").__version__
    except ImportError:
        torchvision_version = None

    project_dir = Path(__file__).resolve().parents[2]
    onnxruntime_web_version = npm_package_version(
        project_dir / "Extension" / "node_modules" / "onnxruntime-web" / "package.json"
    )

    metadata = {
        "model": {
            "name": MODEL_NAME,
            "description": "DINOv2 ViT-S/14 without registers, 21M parameters, patch size 14",
            "sourceRepository": f"https://github.com/{DINOV2_REPO}",
            "modelCard": f"https://github.com/facebookresearch/dinov2/blob/{DINOV2_REVISION}/MODEL_CARD.md",
            "repositoryRevision": DINOV2_REVISION,
            "torchHubEntrypoint": f"torch.hub.load('{pinned_repository}', '{MODEL_NAME}', pretrained=True, trust_repo=True)",
        },
        "checkpoint": {
            "url": CHECKPOINT_URL,
            "filename": checkpoint_cache.name,
            "sha256": checkpoint_sha256,
        },
        "descriptor": {
            "layer": "forward_features(pixel_values)['x_norm_clstoken']",
            "dimension": EMBEDDING_DIM,
            "normalization": "L2-normalized by the browser embedding engine after inference (not baked into the ONNX graph)",
        },
        "onnxContract": {
            "inputName": "pixel_values",
            "inputShape": ["batch_size", 3, CROP_SIZE, CROP_SIZE],
            "inputType": "float32",
            "outputName": "image_features",
            "outputShape": ["batch_size", EMBEDDING_DIM],
            "dynamicBatchAxis": True,
            "opset": OPSET,
        },
        "toolchain": {
            "python": sys.version.split()[0],
            "torch": torch_version,
            "torchvision": torchvision_version,
            "dinov2RepositoryRevision": DINOV2_REVISION,
            "transformers": "not used (official Meta torch.hub implementation)",
            "onnx": onnx.__version__,
            "onnxruntimePython": ort.__version__,
            "onnxruntimeWeb": onnxruntime_web_version,
            "exporter": {
                "name": Path(__file__).name,
                "version": EXPORTER_VERSION,
                "sha256": sha256_of(Path(__file__).resolve()),
            },
        },
        "export": {
            "command": "python3 tools/model-export/export_dinov2_vits14_onnx.py --output-dir Models/downloads",
            "torchOnnxExportCall": export_command,
            "xFormersDisabled": True,
            "date": datetime.now(timezone.utc).isoformat(),
        },
        "artifacts": {
            "onnx": {
                "path": "Models/downloads/dinov2_vits14.onnx",
                "sha256": sha256_of(onnx_path),
            },
            "config": {
                "path": "Models/downloads/dinov2_vits14_config.json",
                "sha256": sha256_of(config_path),
            },
        },
    }
    metadata_path = output_dir / "dinov2_vits14_export_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Provenance metadata: {metadata_path}", flush=True)
    print("Done. Compare the generated artifact hashes with Models/models.lock.json.")


if __name__ == "__main__":
    main()
