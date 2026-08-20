'use strict';

// PMDG requires applications built with the 777 SDK to present the SDK EULA
// and obtain an explicit user acceptance. Keep the acceptance token stable for
// this reviewed SDK/EULA revision; change it when the bundled integration is
// audited against a newer vendor EULA.
const PMDG_777_SDK_EULA_ACCEPTANCE_VERSION = 'pmdg-777-msfs-sdk-eula-2024-06';

function getPmdg777SdkEulaAcceptance(settings) {
  const value = settings?.integrations?.pmdg777Sdk;
  const accepted = value?.eulaAcceptedVersion === PMDG_777_SDK_EULA_ACCEPTANCE_VERSION;
  return {
    accepted,
    acceptedAt: accepted && typeof value?.eulaAcceptedAt === 'string'
      ? value.eulaAcceptedAt
      : null,
    version: PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
  };
}

module.exports = {
  PMDG_777_SDK_EULA_ACCEPTANCE_VERSION,
  getPmdg777SdkEulaAcceptance,
};
