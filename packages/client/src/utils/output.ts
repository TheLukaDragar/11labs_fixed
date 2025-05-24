import { loadAudioConcatProcessor } from "./audioConcatProcessor";
import { FormatConfig } from "./connection";

export class Output {
  private audioElement: HTMLAudioElement | null = null;
  private isContextSuspended: boolean = false;

  public static async create({
    sampleRate,
    format,
  }: FormatConfig): Promise<Output> {
    let context: AudioContext | null = null;
    try {
      context = new AudioContext({ sampleRate });
      const analyser = context.createAnalyser();
      const gain = context.createGain();
      gain.connect(analyser);
      analyser.connect(context.destination);
      await loadAudioConcatProcessor(context.audioWorklet);
      const worklet = new AudioWorkletNode(context, "audio-concat-processor");
      worklet.port.postMessage({ type: "setFormat", format });
      worklet.connect(gain);

      const mediaStreamDestination = context.createMediaStreamDestination();

      await context.resume();

      return new Output(
        context,
        analyser,
        gain,
        worklet,
        mediaStreamDestination
      );
    } catch (error) {
      context?.close();
      throw error;
    }
  }

  private constructor(
    public readonly context: AudioContext,
    public readonly analyser: AnalyserNode,
    public readonly gain: GainNode,
    public readonly worklet: AudioWorkletNode,
    public readonly mediaStreamDestination: MediaStreamAudioDestinationNode
  ) {}

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

  public async setOutputDevice(deviceId: string): Promise<boolean> {
    // Check if the device selection API is supported
    if (!("setSinkId" in HTMLAudioElement.prototype)) {
      return false;
    }

    if (!this.audioElement) {
      // Reroute audio through the media stream
      this.analyser.disconnect(this.context.destination);
      this.analyser.connect(this.mediaStreamDestination);

      // Create and start the audio element
      this.audioElement = new Audio();
      this.audioElement.srcObject = this.mediaStreamDestination.stream;
      this.audioElement.play();
    }

    // Set the output device
    await (this.audioElement as any).setSinkId(deviceId);
    return true;
  }
}
