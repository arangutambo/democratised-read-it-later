/**
 * Talking to the embedded player.
 *
 * The iframe is cross-origin, so everything goes through `postMessage`: commands out, and a
 * stream of `infoDelivery` messages back carrying the current time and play state. Knowing the
 * time is what makes the rest work — a captured frame can be stamped with the moment it was
 * actually taken, the transcript can follow along, and a quote can carry the second it was
 * said.
 *
 * Reader also asks for a player with **no controls of its own**. Two reasons, and the first is
 * not cosmetic: `capturePage` photographs whatever is drawn, so YouTube's control bar, its
 * caption overlay and its end-screen suggestions all landed inside captured frames. The second
 * is that once Reader knows the playback state it can offer the controls that actually matter
 * here — speed especially, for a lecture.
 */

/** Player states, as YouTube numbers them. */
export const PLAYING = 1;
export const PAUSED = 2;

export interface PlayerState {
	/** Seconds into the video. */
	time: number;
	duration: number;
	playing: boolean;
	rate: number;
}

/** Speeds worth offering. A lecture is watchable well past 1×; music is not. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * The embed URL.
 *
 * `controls=0` is what keeps captured frames clean. `cc_load_policy=0` stops burned-in
 * captions, `iv_load_policy=3` the annotation layer, and `rel=0` keeps end-screen suggestions
 * to the same channel — all of which otherwise appear in a frame you meant to be a slide.
 */
export function embedUrl(videoId: string): string {
	const params = new URLSearchParams({
		enablejsapi: "1",
		controls: "0",
		disablekb: "1",
		cc_load_policy: "0",
		iv_load_policy: "3",
		rel: "0",
		modestbranding: "1",
		playsinline: "1",
		origin: "app://obsidian.md",
	});

	return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/**
 * A live view of the player.
 *
 * Position is polled rather than pushed. `infoDelivery` arrives on its own schedule and stops
 * entirely while paused, so a `listening` ping keeps the picture current — and the interval is
 * what the transcript's follow-along resolution is set by.
 */
export class PlayerLink {
	private readonly frame: HTMLIFrameElement;
	private readonly onUpdate: (state: PlayerState) => void;

	private state: PlayerState = { time: 0, duration: 0, playing: false, rate: 1 };
	private timer?: number;
	private listener?: (event: MessageEvent) => void;

	constructor(frame: HTMLIFrameElement, onUpdate: (state: PlayerState) => void) {
		this.frame = frame;
		this.onUpdate = onUpdate;
	}

	get current(): PlayerState {
		return this.state;
	}

	start(): void {
		this.listener = (event: MessageEvent) => this.receive(event);
		window.addEventListener("message", this.listener);

		/*
		 * Unload the caption and annotation modules outright.
		 *
		 * `cc_load_policy=0` only sets a default, and an account with "always show captions"
		 * overrides it — which is why burned-in subtitles kept appearing in captured frames
		 * despite the parameter. Unloading the module is the instruction the player cannot
		 * ignore. Repeated because it is only honoured once the player is ready, and there is
		 * no ready event on this channel.
		 */
		for (const delay of [400, 1200, 2500]) {
			window.setTimeout(() => {
				this.send("command", "unloadModule", ["captions"]);
				this.send("command", "unloadModule", ["annotations"]);
			}, delay);
		}

		// Four times a second: fine enough that the highlighted paragraph never lags visibly,
		// coarse enough to be free.
		this.timer = window.setInterval(() => this.send("listening"), 250);
	}

	stop(): void {
		if (this.listener) window.removeEventListener("message", this.listener);
		if (this.timer !== undefined) window.clearInterval(this.timer);
		this.listener = undefined;
		this.timer = undefined;
	}

	private receive(event: MessageEvent): void {
		if (event.source !== this.frame.contentWindow) return;

		let payload: { event?: string; info?: Record<string, unknown> };
		try {
			payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
		} catch {
			return;
		}

		const info = payload?.info;
		if (!info) return;

		const next = { ...this.state };
		if (typeof info.currentTime === "number") next.time = info.currentTime;
		if (typeof info.duration === "number" && info.duration > 0) next.duration = info.duration;
		if (typeof info.playerState === "number") next.playing = info.playerState === PLAYING;
		if (typeof info.playbackRate === "number") next.rate = info.playbackRate;

		const changed =
			next.time !== this.state.time ||
			next.playing !== this.state.playing ||
			next.rate !== this.state.rate ||
			next.duration !== this.state.duration;

		this.state = next;
		if (changed) this.onUpdate(next);
	}

	private send(event: string, func?: string, args: unknown[] = []): void {
		const message = func
			? JSON.stringify({ event: "command", func, args })
			: JSON.stringify({ event, id: 1, channel: "widget" });

		this.frame.contentWindow?.postMessage(message, "*");
	}

	play(): void {
		this.send("command", "playVideo");
	}

	pause(): void {
		this.send("command", "pauseVideo");
	}

	toggle(): void {
		if (this.state.playing) this.pause();
		else this.play();
	}

	seekTo(seconds: number): void {
		this.send("command", "seekTo", [Math.max(0, seconds), true]);
		// Optimistic, so the transcript jumps immediately rather than on the next poll.
		this.state = { ...this.state, time: Math.max(0, seconds) };
		this.onUpdate(this.state);
	}

	/**
	 * A frame with nothing on it but the frame.
	 *
	 * A paused embed draws its own furniture — the big play button, the link badge, the "More
	 * videos" strip — and `capturePage` photographs all of it. Playing clears every one of
	 * them, so a capture taken while paused briefly resumes, waits for the overlay to go, and
	 * pauses again. The video advances by less than half a second, which is inside the gap
	 * between transcript paragraphs and so cannot move which one a clip belongs to.
	 */
	async withCleanFrame<T>(capture: () => Promise<T>): Promise<T> {
		const wasPaused = !this.state.playing;
		if (!wasPaused) return capture();

		this.play();
		await new Promise((resolve) => window.setTimeout(resolve, 450));

		try {
			return await capture();
		} finally {
			this.pause();
		}
	}

	setRate(rate: number): void {
		this.send("command", "setPlaybackRate", [rate]);
		this.state = { ...this.state, rate };
		this.onUpdate(this.state);
	}
}

/**
 * The paragraph being spoken at a given moment.
 *
 * Returns the last paragraph that has started, which is what "where are we" means for speech —
 * a binary search rather than a scan, because this runs four times a second.
 */
export function paragraphAt(starts: readonly number[], time: number): number {
	if (starts.length === 0) return 0;

	let low = 0;
	let high = starts.length - 1;
	let found = 0;

	while (low <= high) {
		const mid = (low + high) >> 1;
		if (starts[mid] <= time) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return found;
}
