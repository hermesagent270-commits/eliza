# Paradee voice for Android consumers

Android library for on-device English speech and transcription in the app
process, with `libelizainference` (llama.cpp based). There is no ONNX, agent,
inference server, account or network use.

- **Speech:** Paradee-8M v1.0 (one voice, `af_heart`, 24 kHz). Native misaki
  G2P makes the phonemes: the misaki lexicon and rules, with eSpeak NG only
  for words outside the lexicon.
- **Transcription:** the ASR head of `libelizainference`. The default is
  Phonon-2 (Parakeet-TDT 0.6B, five-value weights) at
  `<bundle>/asr/phonon-2-fv5.gguf`: batch (16 kHz mono in) and streaming (any
  rate). The Qwen3-ASR text + mmproj pair is the batch-only alternative
  (`ELIZA_ASR_BACKEND=qwen3`). `asr/` holds one of the two, as the
  `mobile-voice` catalog record pins it.

```java
VoiceAssets.Bundle bundle = VoiceAssets.install(context); // worker thread
ParadeeVoice voice = bundle.openVoice();
ParadeeVoice.Audio audio = voice.synthesize("Hello.", 1.0f);
NativeAsr asr = new NativeAsr(asrBundleDir); // a directory with asr/
String text = asr.transcribe(pcm16kMono);
if (asr.supportsStreaming()) {
  try (NativeAsr.Stream stream = asr.openStream(48000)) {
    stream.feed(chunk);              // audio thread: buffers only
    String running = stream.partial(); // worker thread
    String finalText = stream.finish();
  }
}
```

`cancel()` on either object stops the running call from another thread; that
call throws `java.util.concurrent.CancellationException`. `trimMemory()` frees
the weights and keeps the object; the next call reloads them.

The JNI bridge is the app's `app/src/main/elizavoice-jni`, built here as
`libparadeevoicejni.so` for `ai.eliza.voice.VoiceNative` with only the voice
natives. Its `JNI_OnLoad` registers the methods and is its only export.

## Build

Generate the native inputs and the hash-pinned bundle (NDK 28.2, arm64-v8a and
x86_64, 16 KiB pages). Pins are in `inputs.json` and must equal the fork pins
in `tools/paradee/pins.json` and `tools/misaki-g2p/pins.json`. The GGUF and the
lexicon are converted in the fork from the pinned PyTorch weights and misaki
data; `--python` needs torch and numpy. `--model-cache` is searched first.

```sh
ANDROID_HOME=~/Library/Android/sdk node packages/app/scripts/paradee-voice/build-native.ts \
  --workspace /path/to/build/paradee-voice [--model-cache /path/to/models] [--python python3]
```

A consumer Gradle library sets `ext.elizaParadeeSourceDir` to this directory
and applies `consumer.gradle`. Optional properties: `elizaParadeeNativeDir`,
`elizaParadeeFfiIncludeDir`, `elizaParadeeInferenceLibDir`, and
`elizaParadeePackageInference=false` when the app already packages
`libelizainference.so`. The build fails if a generated file differs from
`native/build-record.json`.

Store the model uncompressed in the APK (`androidResources { noCompress 'gguf', 'lex' }`).
A host made by `scripts/mobile/android/consumer-host.mjs` sets this in its profile:
`"androidResources": { "noCompress": ["gguf", "lex"] }`.

## Licenses

The Java and C++ sources here are MIT. Paradee-8M v1.0 weights
(sahilmahendrakar/Paradee-8M-v1.0) and the misaki lexicon data
(hexgrad/misaki) are Apache-2.0. Phonon-2 weights (FermionResearch/Phonon-2,
derived from NVIDIA parakeet-tdt-0.6b-v3) are CC-BY-4.0: show the attribution
and ship Fermion's NOTICE (also embedded in the GGUF as `parakeet.notice`). The
NOTICE lists CHiME-6 (CC-BY-SA-4.0) and SPGISpeech (Kensho terms) training
audio; that is flagged for review, not a blocker. `libelizainference.so` links eSpeak NG
1.52.0 (GPL-3.0-or-later) statically as the out-of-lexicon fallback, so an APK
that ships it must meet the GPL. The bundle `notices/` carry the eSpeak NG
license, and the misaki (Apache-2.0) and spaCy (MIT) notices for the G2P
rules ported from them.
