#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy_contract.sh
#
# Automated wrapper script to deploy and upgrade the Soroban PaymentRouter contract.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Ensure Node.js is available
if ! command -v node &> /dev/null; then
  echo "❌ Error: Node.js is required but not installed or not in PATH."
  exit 1
fi

# Ensure the stellar CLI is available
if ! command -v stellar &> /dev/null; then
  echo "stellar CLI not found. Install with: cargo install stellar-cli --version 21.0.0" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Derive the network passphrase from the selected network instead of hard-coding
# the testnet value. Supports `--network <name>` and `--network=<name>`.
# ------------------------------------------------------------------------------
NETWORK="testnet"
VERBOSE=0
prev=""
for arg in "$@"; do
  case "${arg}" in
    --network)
      ;;
    --network=*)
      NETWORK="${arg#--network=}"
      ;;
    --verbose|-v)
      VERBOSE=1
      ;;
    *)
      if [ "${prev}" = "--network" ]; then
        NETWORK="${arg}"
      fi
      ;;
  esac
  prev="${arg}"
  if [ "${arg}" = "--network" ]; then
    prev="--network"
  else
    prev=""
  fi
done

# Resolve the passphrase for the selected network via the stellar CLI.
NETWORK_PASSPHRASE=""
if command -v stellar &> /dev/null; then
  NETWORK_PASSPHRASE="$(stellar network ls 2>/dev/null | awk -v net="${NETWORK}" '$1 == net { print $2; exit }' || true)"
fi

# Fall back to well-known passphrases if the CLI cannot resolve the network.
if [ -z "${NETWORK_PASSPHRASE}" ]; then
  case "${NETWORK}" in
    testnet)
      NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
      ;;
    mainnet|pubnet)
      NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
      ;;
    futurenet)
      NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"
      ;;
    *)
      echo "❌ Error: Unable to derive network passphrase for network '${NETWORK}'." >&2
      echo "   Configure it with: stellar network add ${NETWORK} --rpc-url <url> --network-passphrase <passphrase>" >&2
      exit 1
      ;;
  esac
fi

# Validate the passphrase before the first RPC call.
if [ -z "${NETWORK_PASSPHRASE}" ]; then
  echo "❌ Error: Empty network passphrase for network '${NETWORK}'." >&2
  exit 1
fi

if [ "${VERBOSE}" -eq 1 ]; then
  echo "ℹ️  Network: ${NETWORK}"
  echo "ℹ️  Network passphrase: ${NETWORK_PASSPHRASE:0:10}..."
fi

export STELLAR_NETWORK="${NETWORK}"
export STELLAR_NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"

# Execute Node.js deployment script forwarding all arguments
exec node "${SCRIPT_DIR}/deploy.js" "$@"
