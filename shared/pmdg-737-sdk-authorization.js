'use strict';

// PMDG requires applications built with the 737 SDK to present the SDK EULA
// and obtain an explicit user acceptance. Change this token when the bundled
// integration is audited against a newer vendor EULA.
const PMDG_737_SDK_EULA_ACCEPTANCE_VERSION = 'pmdg-737-msfs-sdk-eula-2025-12';

function getPmdg737SdkEulaAcceptance(settings) {
  const value = settings?.integrations?.pmdg737Sdk;
  const accepted = value?.eulaAcceptedVersion === PMDG_737_SDK_EULA_ACCEPTANCE_VERSION;
  return {
    accepted,
    acceptedAt: accepted && typeof value?.eulaAcceptedAt === 'string'
      ? value.eulaAcceptedAt
      : null,
    version: PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
  };
}

module.exports = {
  PMDG_737_SDK_EULA_ACCEPTANCE_VERSION,
  getPmdg737SdkEulaAcceptance,
};
