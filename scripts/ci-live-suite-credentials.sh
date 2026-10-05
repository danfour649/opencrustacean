#!/usr/bin/env bash
# Decide whether a scheduled live lane can run with the credentials in the
# environment. Missing credentials skip the lane. A present credential still
# runs, and the test's own failure fails the job.
set -euo pipefail

emit() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${key}=${value}" >>"$GITHUB_OUTPUT"
  else
    echo "${key}=${value}"
  fi
}

has_any() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      return 0
    fi
  done
  return 1
}

provider_present() {
  case "$1" in
    anthropic)
      has_any ANTHROPIC_API_KEY ANTHROPIC_API_TOKEN ANTHROPIC_API_KEY_OLD ANTHROPIC_OAUTH_TOKEN \
        CLAUDE_CODE_OAUTH_TOKEN OPENCLAW_CLAUDE_CREDENTIALS_JSON OPENCLAW_CLAUDE_JSON
      ;;
    google)
      has_any GEMINI_API_KEY GOOGLE_API_KEY OPENCLAW_GEMINI_SETTINGS_JSON
      ;;
    minimax) has_any MINIMAX_API_KEY ;;
    moonshot) has_any MOONSHOT_API_KEY KIMI_API_KEY ;;
    openai) has_any OPENAI_API_KEY ;;
    opencode | opencode-go) has_any OPENCODE_API_KEY OPENCODE_ZEN_API_KEY ;;
    openrouter) has_any OPENROUTER_API_KEY ;;
    xai) has_any XAI_API_KEY ;;
    zai) has_any ZAI_API_KEY Z_AI_API_KEY ;;
    fireworks) has_any FIREWORKS_API_KEY ;;
    deepseek) has_any DEEPSEEK_API_KEY ;;
    codex) has_any OPENCLAW_CODEX_AUTH_JSON ;;
    factory) has_any FACTORY_API_KEY ;;
    gemini)
      has_any GEMINI_API_KEY GOOGLE_API_KEY OPENCLAW_GEMINI_SETTINGS_JSON
      ;;
    *)
      echo "Unknown live provider id: $1" >&2
      exit 1
      ;;
  esac
}

suite_requirement() {
  case "$1" in
    native-live-src-infra | native-live-extensions-l-n | native-live-extensions-o-z-other | native-live-extensions-a-k)
      echo "none"
      ;;
    native-live-src-agents | native-live-test | native-live-src-gateway-core | native-live-src-gateway-backends | live-gateway-docker | openwebui)
      echo "all:openai"
      ;;
    live-cli-backend-docker | live-acp-bind-docker)
      echo "any:anthropic,openai"
      ;;
    live-subagent-announce-docker)
      echo "any:openai,google"
      ;;
    live-cache)
      echo "all:openai,anthropic"
      ;;
    live-gateway-advisory-docker-deepseek-fireworks)
      echo "any:deepseek,fireworks"
      ;;
    live-gateway-advisory-docker-opencode-openrouter)
      echo "any:opencode,openrouter"
      ;;
    live-gateway-advisory-docker-xai-zai)
      echo "any:xai,zai"
      ;;
    live-codex-harness*)
      echo "all:openai"
      ;;
    *opencode*)
      echo "all:opencode"
      ;;
    *anthropic*)
      echo "all:anthropic"
      ;;
    *google*)
      echo "all:google"
      ;;
    *minimax*)
      echo "all:minimax"
      ;;
    *moonshot*)
      echo "all:moonshot"
      ;;
    *openai* | *gpt56*)
      echo "all:openai"
      ;;
    *openrouter*)
      echo "all:openrouter"
      ;;
    *fireworks*)
      echo "all:fireworks"
      ;;
    *deepseek*)
      echo "all:deepseek"
      ;;
    *xai*)
      echo "all:xai"
      ;;
    *zai*)
      echo "all:zai"
      ;;
    *)
      echo "none"
      ;;
  esac
}

split_csv() {
  local raw="$1"
  local entry
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -z "$entry" ]] && continue
    printf '%s\n' "$entry"
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
}

record_docker_plan_absences() {
  local raw="${OPENCLAW_DOCKER_PLAN_CREDENTIALS:-}"
  local missing=()
  local credential
  while IFS= read -r credential; do
    if provider_present "$credential"; then
      continue
    fi
    echo "Docker lanes that require ${credential} will be skipped; other lanes still run."
    missing+=("$credential")
  done < <(split_csv "$raw")
  local joined=""
  if [[ ${#missing[@]} -gt 0 ]]; then
    joined="$(
      IFS=,
      echo "${missing[*]}"
    )"
  fi
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "OPENCLAW_DOCKER_ABSENT_CREDENTIALS=${joined}" >>"$GITHUB_ENV"
  else
    echo "OPENCLAW_DOCKER_ABSENT_CREDENTIALS=${joined}"
  fi
  emit skip false
}

evaluate_provider_list() {
  local mode="$1"
  local raw="$2"
  local present=()
  local missing=()
  local provider
  while IFS= read -r provider; do
    if provider_present "$provider"; then
      present+=("$provider")
    else
      missing+=("$provider")
    fi
  done < <(split_csv "$raw")
  local present_csv=""
  local missing_csv=""
  if [[ ${#present[@]} -gt 0 ]]; then
    present_csv="$(
      IFS=,
      echo "${present[*]}"
    )"
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    missing_csv="$(
      IFS=,
      echo "${missing[*]}"
    )"
  fi
  case "$mode" in
    all)
      if [[ -n "$missing_csv" ]]; then
        echo "Skipping live lane: missing credential for ${missing_csv}."
        emit skip true
        return
      fi
      emit skip false
      ;;
    any)
      if [[ -z "$present_csv" ]]; then
        echo "Skipping live lane: none of ${raw} has a credential."
        emit skip true
        return
      fi
      emit skip false
      ;;
    drop)
      if [[ -z "$present_csv" ]]; then
        echo "Skipping live lane: none of ${raw} has a credential."
        emit skip true
        return
      fi
      if [[ -n "$missing_csv" ]]; then
        echo "Live providers without a credential will be skipped: ${missing_csv}."
      fi
      if [[ -n "${GITHUB_ENV:-}" ]]; then
        echo "OPENCLAW_LIVE_PROVIDERS=${present_csv}" >>"$GITHUB_ENV"
      else
        echo "OPENCLAW_LIVE_PROVIDERS=${present_csv}"
      fi
      emit skip false
      emit providers "$present_csv"
      ;;
    *)
      echo "Unknown credential mode: ${mode}" >&2
      exit 1
      ;;
  esac
}

if [[ -n "${OPENCLAW_DOCKER_PLAN_CREDENTIALS+x}" ]]; then
  record_docker_plan_absences
  exit 0
fi

if [[ -n "${OPENCLAW_LIVE_SUITE:-}" ]]; then
  requirement="$(suite_requirement "$OPENCLAW_LIVE_SUITE")"
  case "$requirement" in
    none)
      emit skip false
      exit 0
      ;;
    all:* | any:*)
      mode="${requirement%%:*}"
      providers="${requirement#*:}"
      evaluate_provider_list "$mode" "$providers"
      exit 0
      ;;
    *)
      echo "Unhandled suite requirement: ${requirement}" >&2
      exit 1
      ;;
  esac
fi

if [[ -n "${OPENCLAW_LIVE_PROVIDERS:-}" ]]; then
  mode="${OPENCLAW_LIVE_CREDENTIAL_MODE:-all}"
  evaluate_provider_list "$mode" "$OPENCLAW_LIVE_PROVIDERS"
  exit 0
fi

echo "Set OPENCLAW_LIVE_SUITE, OPENCLAW_LIVE_PROVIDERS, or OPENCLAW_DOCKER_PLAN_CREDENTIALS." >&2
exit 1
