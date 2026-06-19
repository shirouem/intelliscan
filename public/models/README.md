# Document Detector Model

Polling Image Solve loads this browser-side model:

```text
/models/document-detector.onnx
```

Put a document/page detector ONNX file at:

```text
public/models/document-detector.onnx
```

The frontend uses `onnxruntime-web` and expects a YOLO-style detection output. Supported common shapes:

- `[1, N, 5 + classes]`
- `[1, 5 + classes, N]`
- `[1, N, 6]` with `x, y, width/height or x2/y2, score, classId`

Do not use a generic COCO YOLO model unless it was trained to detect paper/document classes. The trigger only accepts labels matching document-like names such as `document`, `paper`, `sheet`, `page`, `invoice`, `receipt`, or `form`.

If your model uses different document class names, update:

```text
public/models/document-detector.labels.json
```
