# FrameAction Runtime

`com.frame-action.runtime` is the standalone Unity package used to import and run SpriteCue Studio data.

## Install

In Unity, open Package Manager and choose **Add package from git URL**:

```text
https://github.com/x32649/sprite-cue-studio.git?path=/unity-package/com.frame-action.runtime
```

For a local checkout, choose **Add package from disk** and select this directory's `package.json`.

SpriteCue Studio reads the installed package metadata to check data-schema compatibility. It does not install, update, fingerprint, or overwrite Runtime files. Projects may embed or customize this package without coupling those changes back to the editor.

## Compatibility

The `frameAction.schemaMin` and `frameAction.schemaMax` fields in `package.json` declare the SpriteCue project schemas supported by this Runtime release.
