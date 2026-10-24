#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/super-looi/vosk-command-models"
stage_root="$repo_dir/.build-assets/vosk"
mkdir -p "$cache_root/zips" "$cache_root/extracted" "$stage_root"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}
need_cmd curl
need_cmd unzip

fetch_model() {
  local language="$1"
  local source_name="$2"
  local target_name="$3"
  local url="$4"
  local zip="$cache_root/zips/${source_name}.zip"
  local extracted="$cache_root/extracted/$source_name"
  local stage="$stage_root/$target_name"

  if [[ ! -f "$zip" ]]; then
    echo "Downloading Vosk $language command model: $source_name"
    curl -fL --retry 4 --retry-delay 2 --connect-timeout 20 -o "$zip.part" "$url"
    mv "$zip.part" "$zip"
  fi

  if [[ ! -d "$extracted" ]] || [[ -z "$(find "$extracted" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Extracting Vosk $language command model..."
    rm -rf "$cache_root/extracted/.tmp-$source_name" "$extracted"
    mkdir -p "$cache_root/extracted/.tmp-$source_name"
    unzip -q "$zip" -d "$cache_root/extracted/.tmp-$source_name"
    if [[ ! -d "$cache_root/extracted/.tmp-$source_name/$source_name" ]]; then
      echo "Unexpected Vosk archive layout for $source_name" >&2
      exit 1
    fi
    mv "$cache_root/extracted/.tmp-$source_name/$source_name" "$extracted"
    rm -rf "$cache_root/extracted/.tmp-$source_name"
  fi

  rm -rf "$stage"
  # Stage by copy so Expo's Android asset copy is deterministic even when the
  # cache and project live on different filesystems.
  cp -a "$extracted" "$stage"
  echo "Prepared $language: $stage"
}

# French fork: bundle only the offline command models that are actually used.
# The RU/UK/EN large models alone made the APK ~530 MB heavier. Choose with
# VOSK_LANGUAGES (space-separated), e.g. VOSK_LANGUAGES="fr en ru uk".
# Without a bundled model, that language still converses normally; only the
# offline driving recognizer falls back to the shared local speech model.
VOSK_LANGUAGES="${VOSK_LANGUAGES:-fr en}"
# Remove models staged by a previous run that are no longer selected.
for staged in "$stage_root"/vosk-command-*; do
  [[ -e "$staged" ]] || continue
  lang="${staged##*/vosk-command-}"
  [[ " $VOSK_LANGUAGES " == *" $lang "* ]] || rm -rf "$staged"
done
for lang in $VOSK_LANGUAGES; do
  case "$lang" in
    fr) fetch_model "FR" "vosk-model-small-fr-0.22" "vosk-command-fr" \
          "https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip" ;;
    # Small mobile model: designed for grammar-constrained recognition on
    # phones, ~40 MB instead of 128 MB for the server-class lgraph model.
    en) fetch_model "EN" "vosk-model-small-en-us-0.15" "vosk-command-en" \
          "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" ;;
    ru) fetch_model "RU" "vosk-model-small-ru-0.22" "vosk-command-ru" \
          "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip" ;;
    uk) fetch_model "UA" "vosk-model-uk-v3-lgraph" "vosk-command-uk" \
          "https://alphacephei.com/vosk/models/vosk-model-uk-v3-lgraph.zip" ;;
    *) echo "Unknown Vosk language: $lang" >&2; exit 1 ;;
  esac
done

echo "Vosk command models ready."
