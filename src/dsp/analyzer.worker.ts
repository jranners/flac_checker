import { runForensicAnalysis, type ForensicDspInput } from './cutoffDetector';
import type { AnalysisResult } from './types';

export interface DspWorkerRequest {
  id: string;
  payload: ForensicDspInput;
}

export interface DspWorkerResponse {
  id: string;
  result?: AnalysisResult;
  error?: string;
}

self.onmessage = (event: MessageEvent<DspWorkerRequest>) => {
  const { id, payload } = event.data;
  try {
    const result = runForensicAnalysis(payload);
    const response: DspWorkerResponse = { id, result };
    const transferables: Transferable[] = [
      result.spectrogram.frequenciesKhz.buffer,
      result.spectrogram.timesSec.buffer,
      result.spectrogram.dbMatrix.buffer,
      result.psdCurve.frequenciesKhz.buffer,
      result.psdCurve.meanDb.buffer,
      result.psdCurve.medianDb.buffer,
      result.psdCurve.p95Db.buffer,
    ];
    self.postMessage(response, { transfer: transferables });
  } catch (err) {
    const response: DspWorkerResponse = {
      id,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
