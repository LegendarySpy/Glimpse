import { useEffect, useState } from "react";

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

interface SharedAnalyserState {
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  stream: MediaStream | null;
  isListening: boolean;
  error: string | null;
}

const sharedState: SharedAnalyserState = {
  audioContext: null,
  analyser: null,
  source: null,
  stream: null,
  isListening: false,
  error: null,
};

const subscribers = new Set<() => void>();

const notifySubscribers = () => {
  subscribers.forEach((callback) => callback());
};

let isStarting = false;

const ensureAudioContext = () => {
  if (!sharedState.audioContext) {
    const AudioContextClass =
      window.AudioContext || (window as unknown as WindowWithWebkitAudio).webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Audio Context not supported");
    }

    sharedState.audioContext = new AudioContextClass();
  }

  return sharedState.audioContext;
};

const startSharedAnalyser = async () => {
  if (sharedState.isListening || isStarting) return;
  isStarting = true;

  let localStream: MediaStream | null = null;

  try {
    const audioContext = ensureAudioContext();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;

    const source = audioContext.createMediaStreamSource(localStream);
    source.connect(analyser);

    sharedState.stream = localStream;
    sharedState.source = source;
    sharedState.analyser = analyser;
    sharedState.isListening = true;
    sharedState.error = null;
    isStarting = false;
    notifySubscribers();
  } catch (error) {
    console.error("Error accessing microphone:", error);
    sharedState.error = "Mic Access Denied";
    sharedState.isListening = false;
    isStarting = false;

    if (localStream) {
      (localStream as MediaStream).getTracks().forEach(t => t.stop());
    }

    if (sharedState.stream) {
      sharedState.stream.getTracks().forEach(t => t.stop());
      sharedState.stream = null;
    }

    notifySubscribers();
    throw error;
  }
};

const stopSharedAnalyser = () => {
  if (!sharedState.isListening) return;

  sharedState.source?.disconnect();
  sharedState.stream?.getTracks().forEach((track) => track.stop());

  sharedState.source = null;
  sharedState.stream = null;
  sharedState.analyser = null;
  sharedState.isListening = false;
  notifySubscribers();
};

export const useSharedAnalyser = () => {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const callback = () => {
      forceUpdate((value) => value + 1);
    };

    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  }, []);

  return {
    analyser: sharedState.analyser,
    isListening: sharedState.isListening,
    error: sharedState.error,
    start: startSharedAnalyser,
    stop: stopSharedAnalyser,
  };
};
