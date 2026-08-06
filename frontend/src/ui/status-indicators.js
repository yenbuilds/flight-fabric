export function createStatusIndicatorsController({
  statusStore = null,
} = {}) {
  function updateVreSamplingIndicator(message) {
    statusStore?.updateVreSampling?.(message);
  }

  function updateAssistsIndicator(data) {
    statusStore?.updateAssists?.(data);
  }

  function updateSurfaceIndicator(surface) {
    statusStore?.updateSurface?.(surface);
  }

  function updateRecordingIndicator(message) {
    statusStore?.updateRecording?.(message);
  }

  return {
    updateAssistsIndicator,
    updateRecordingIndicator,
    updateVreSamplingIndicator,
    updateSurfaceIndicator,
  };
}
