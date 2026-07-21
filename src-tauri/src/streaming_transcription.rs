use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
use std::time::Duration;

use tauri::{AppHandle, Manager};

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
use crate::pill;
use crate::{AppRuntime, AppState, model_manager::ReadyModel};

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const CHUNK_SAMPLES_16K: usize = 8960;

pub struct StreamingSession {
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    result: Arc<Mutex<String>>,
}

impl StreamingSession {
    pub fn start(app: &AppHandle<AppRuntime>, ready_model: &ReadyModel) -> Self {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop_flag = Arc::clone(&stop_flag);
        let result = Arc::new(Mutex::new(String::new()));
        let thread_result = Arc::clone(&result);
        let app_handle = app.clone();
        let model = ready_model.clone();

        let handle = std::thread::Builder::new()
            .name("streaming-transcription".into())
            .spawn(move || {
                streaming_thread(app_handle, model, thread_stop_flag, thread_result);
            })
            .expect("failed to spawn streaming transcription thread");

        Self {
            stop_flag,
            handle: Some(handle),
            result,
        }
    }

    pub fn stop(mut self, _app: &AppHandle<AppRuntime>) -> String {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        // The worker reads and clears the transcript while still holding the
        // session lock, so by the time it joins the value here is final.
        std::mem::take(&mut self.result.lock().unwrap())
    }
}

impl Drop for StreamingSession {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn streaming_thread(
    app: AppHandle<AppRuntime>,
    model: ReadyModel,
    stop_flag: Arc<AtomicBool>,
    result: Arc<Mutex<String>>,
) {
    let state = app.state::<AppState>();
    let transcriber = state.local_transcriber();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let _ = (&model, &stop_flag, &result, &transcriber);

    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        // Hold the transcriber for the whole session so library transcriptions
        // can't interleave on the shared runtime and corrupt our transcript.
        let session = transcriber.begin_streaming_session();

        if let Err(err) = session.warm(&model) {
            tracing::error!("[streaming] Failed to preload model: {err}");
            return;
        }
        session.reset();

        let recorder = state.pill().recorder();
        let mut buffer_offset: usize = 0;
        let mut resampler: Option<StreamResampler> = None;
        let mut pending: Vec<f32> = Vec::new();
        let mut last_text = String::new();

        // Transcribe every whole chunk currently buffered, emitting on change.
        let transcribe_ready_chunks = |pending: &mut Vec<f32>, last_text: &mut String| {
            let mut processed = 0;
            while processed + CHUNK_SAMPLES_16K <= pending.len() {
                let chunk = &pending[processed..processed + CHUNK_SAMPLES_16K];
                match session.transcribe_chunk(&model, chunk) {
                    Ok(transcript) => {
                        if transcript != *last_text {
                            last_text.clone_from(&transcript);
                            pill::emit_pill_mode(&app, true, &transcript);
                        }
                    }
                    Err(err) => {
                        tracing::error!("[streaming] Chunk transcription failed: {err}");
                    }
                }
                processed += CHUNK_SAMPLES_16K;
            }
            if processed > 0 {
                pending.drain(..processed);
            }
        };

        while !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(POLL_INTERVAL);

            let Some((new_samples, sample_rate, new_offset)) =
                recorder.read_live_samples(buffer_offset)
            else {
                continue;
            };

            if new_samples.is_empty() {
                continue;
            }

            buffer_offset = new_offset;
            append_samples(&new_samples, sample_rate, &mut resampler, &mut pending);
            transcribe_ready_chunks(&mut pending, &mut last_text);
        }

        if let Some((new_samples, sample_rate, _)) = recorder.read_live_samples(buffer_offset)
            && !new_samples.is_empty()
        {
            append_samples(&new_samples, sample_rate, &mut resampler, &mut pending);
            transcribe_ready_chunks(&mut pending, &mut last_text);
        }

        if !pending.is_empty() {
            pending.resize(CHUNK_SAMPLES_16K, 0.0);
            if let Ok(transcript) = session.transcribe_chunk(&model, &pending)
                && transcript != last_text
            {
                pill::emit_pill_mode(&app, true, &transcript);
            }
        }

        *result.lock().unwrap() = session.finish();
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn append_samples(
    new_samples: &[f32],
    sample_rate: u32,
    resampler: &mut Option<StreamResampler>,
    pending: &mut Vec<f32>,
) {
    if sample_rate == 16_000 {
        pending.extend_from_slice(new_samples);
    } else {
        if resampler.as_ref().is_none_or(|r| r.in_rate != sample_rate) {
            *resampler = Some(StreamResampler::new(sample_rate, 16_000));
        }
        resampler.as_mut().unwrap().process(new_samples, pending);
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
struct StreamResampler {
    in_rate: u32,
    step: f64,
    pos: f64,
    prev: f32,
    has_prev: bool,
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
impl StreamResampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            in_rate,
            step: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            prev: 0.0,
            has_prev: false,
        }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let last = (input.len() - 1) as f64;
        while self.pos <= last {
            let base = self.pos.floor();
            let frac = (self.pos - base) as f32;
            let idx = base as isize;
            let current = if idx < 0 {
                if self.has_prev { self.prev } else { input[0] }
            } else {
                input[idx as usize]
            };
            let next = input[(idx + 1).clamp(0, input.len() as isize - 1) as usize];
            out.push(current + (next - current) * frac);
            self.pos += self.step;
        }
        self.pos -= input.len() as f64;
        self.prev = input[input.len() - 1];
        self.has_prev = true;
    }
}
