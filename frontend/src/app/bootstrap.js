// ES module - strict mode is implicit in modules.
import '../maps/runtime.js';
import '../../app-settings-shared.js';
import { vueRuntimeContext } from '../vue/main.js';
import { initAppRuntime } from './runtime.js';

export async function initDashboardBootstrap() {
  await initAppRuntime({
    stores: vueRuntimeContext.stores,
  });
}

void initDashboardBootstrap().catch((error) => {
  console.error('[INIT] Dashboard bootstrap failed:', error);
});
