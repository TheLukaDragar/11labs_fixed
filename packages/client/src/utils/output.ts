import { loadAudioConcatProcessor } from "./audioConcatProcessor";
import { FormatConfig } from "./connection";

export type OutputConfig = {
  useMediaAudioMode?: boolean; // 🎵 NEW: Use MediaStreamDestination to avoid device claiming
};

export class Output {
  private audioElement: HTMLAudioElement | null = null;
  private isContextSuspended: boolean = false;
  private useMediaAudioMode: boolean = false;

  public static async create({
    sampleRate,
    format,
    useMediaAudioMode = false,
  }: FormatConfig & OutputConfig): Promise<Output> {
    let context: AudioContext | null = null;
    let audioElement: HTMLAudioElement | null = null;

    try {
      context = new AudioContext({ sampleRate });
      const analyser = context.createAnalyser();
      const gain = context.createGain();

      await loadAudioConcatProcessor(context.audioWorklet);
      const worklet = new AudioWorkletNode(context, "audio-concat-processor");
      worklet.port.postMessage({ type: "setFormat", format });
      worklet.connect(gain);

      const mediaStreamDestination = context.createMediaStreamDestination();

      if (useMediaAudioMode) {
        // 🎵 MEDIA AUDIO MODE: Use MediaStreamDestination to avoid claiming system audio device
        console.log(
          "🎵 [Audio Mode] Using MediaStreamDestination to preserve media app audio quality"
        );

        // Route through MediaStream instead of context.destination
        gain.connect(analyser);
        analyser.connect(mediaStreamDestination);

        // Create audio element for playback without automatic device claiming
        audioElement = new Audio();
        audioElement.srcObject = mediaStreamDestination.stream;
        // Set volume and configure for voice content
        audioElement.volume = 1.0;
        audioElement.preload = "none";
        // Start playback to enable audio routing (but won't claim specific devices)
        try {
          await audioElement.play();
        } catch (playError) {
          console.warn(
            "🎵 [Audio Mode] Audio element autoplay blocked, will start on first audio chunk"
          );
        }
      } else {
        // 🔊 LEGACY MODE: Direct connection to context.destination (may claim system audio)
        console.log("🔊 [Audio Mode] Using direct audio output (legacy mode)");
        gain.connect(analyser);
        analyser.connect(context.destination);
      }

      await context.resume();

      return new Output(
        context,
        analyser,
        gain,
        worklet,
        mediaStreamDestination,
        audioElement,
        useMediaAudioMode
      );
    } catch (error) {
      audioElement?.pause();
      context?.close();
      throw error;
    }
  }

  private constructor(
    public readonly context: AudioContext,
    public readonly analyser: AnalyserNode,
    public readonly gain: GainNode,
    public readonly worklet: AudioWorkletNode,
    public readonly mediaStreamDestination: MediaStreamAudioDestinationNode,
    audioElement: HTMLAudioElement | null,
    useMediaAudioMode: boolean
  ) {
    this.audioElement = audioElement;
    this.useMediaAudioMode = useMediaAudioMode;
  }

  public async close() {
    this.audioElement?.pause();
    this.audioElement = null;
    await this.context.close();
  }

  /**
   * Suspend the AudioContext to release audio device resources when not speaking
   */
  public async suspendForDucking(): Promise<void> {
    if (this.context.state === "running" && !this.isContextSuspended) {
      await this.context.suspend();
      this.isContextSuspended = true;
    }
  }

  /**
   * Resume the AudioContext when about to speak
   */
  public async resumeFromDucking(): Promise<void> {
    if (this.context.state === "suspended" && this.isContextSuspended) {
      await this.context.resume();
      this.isContextSuspended = false;
    }
  }

  /**
   * Check if the context is currently suspended for ducking
   */
  public isDucked(): boolean {
    return this.isContextSuspended;
  }

  /**
   * Ensure audio element is playing for media audio mode
   * Handles autoplay blocking by starting playback when first audio chunk arrives
   */
  public async ensureAudioElementPlaying(): Promise<void> {
    if (this.useMediaAudioMode && this.audioElement) {
      if (this.audioElement.paused) {
        try {
          console.log(
            "🎵 [Media Audio Mode] Starting audio element playback for first audio chunk"
          );
          await this.audioElement.play();
        } catch (playError) {
          console.warn(
            "🎵 [Media Audio Mode] Could not start audio element:",
            playError
          );
          // Audio element play failed - this is OK, audio will still work through default routing
        }
      }
    }
  }

  public async setOutputDevice(deviceId: string): Promise<boolean> {
    // 🚫 Prevent device claiming when preserving media audio quality
    if (this.useMediaAudioMode) {
      console.log(
        `🚫 [Media Audio Mode] setOutputDevice disabled to preserve media app audio quality`
      );
      console.log(
        `🚫 [Media Audio Mode] Requested device: ${deviceId} - ignoring to avoid conflicts with Spotify/media apps`
      );
      return false;
    }

    // Check if the device selection API is supported
    if (!("setSinkId" in HTMLAudioElement.prototype)) {
      console.warn(
        "🔊 [Device Selection] setSinkId not supported in this browser"
      );
      return false;
    }

    if (!this.audioElement) {
      console.log(
        "🔊 [Device Selection] Creating audio element for device-specific output"
      );

      // Reroute audio through the media stream
      this.analyser.disconnect(this.context.destination);
      this.analyser.connect(this.mediaStreamDestination);

      // Create and start the audio element
      this.audioElement = new Audio();
      this.audioElement.srcObject = this.mediaStreamDestination.stream;
      try {
        await this.audioElement.play();
      } catch (playError) {
        console.warn(
          "🔊 [Device Selection] Audio element play blocked:",
          playError
        );
      }
    }

    try {
      // Set the output device
      await (this.audioElement as any).setSinkId(deviceId);
      console.log(
        `✅ [Device Selection] Successfully set output device: ${deviceId}`
      );
      return true;
    } catch (error) {
      console.error(
        "❌ [Device Selection] Failed to set output device:",
        error
      );
      return false;
    }
  }
}
