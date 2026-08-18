import { useEffect, useRef, useState } from 'react';

type SpeechStatus = 'idle' | 'recording' | 'processing';

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
};

export function useSpeechRecognition(onTranscript: (transcript: string) => void) {
  const callbackRef = useRef(onTranscript);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const SpeechRecognitionConstructor = typeof window === 'undefined'
    ? undefined
    : (window as SpeechWindow).SpeechRecognition
      || (window as SpeechWindow).webkitSpeechRecognition;

  callbackRef.current = onTranscript;

  useEffect(() => () => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
  }, []);

  function start() {
    if (!SpeechRecognitionConstructor || recognitionRef.current) return;
    const recognition = new SpeechRecognitionConstructor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcripts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const transcript = event.results[index]?.[0]?.transcript;
        if (transcript) transcripts.push(transcript);
      }
      const transcript = transcripts.join('').trim();
      if (transcript) callbackRef.current(transcript);
      setStatus('processing');
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setStatus('idle');
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setStatus('idle');
    };
    recognitionRef.current = recognition;
    setStatus('recording');
    recognition.start();
  }

  function stop() {
    if (!recognitionRef.current) return;
    setStatus('processing');
    recognitionRef.current.stop();
  }

  return {
    supported: Boolean(SpeechRecognitionConstructor),
    status,
    start,
    stop
  };
}
