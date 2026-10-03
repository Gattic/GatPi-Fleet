/** Fixed-capacity ring buffer of samples. */
export class Series {
	private readonly values: Float64Array;
	private next = 0;
	private count = 0;

	constructor(capacity: number) {
		this.values = new Float64Array(capacity);
	}

	push(value: number): void {
		this.values[this.next] = value;
		this.next = (this.next + 1) % this.values.length;
		this.count = Math.min(this.count + 1, this.values.length);
	}

	/** The most recent `n` samples (all by default), oldest first. */
	last(n = this.count): number[] {
		const take = Math.min(n, this.count);
		const result = new Array<number>(take);
		for (let index = 0; index < take; index++) {
			result[index] = this.values[(this.next - take + index + this.values.length) % this.values.length];
		}
		return result;
	}

	latest(): number | undefined {
		return this.count ? this.values[(this.next - 1 + this.values.length) % this.values.length] : undefined;
	}

	get length(): number {
		return this.count;
	}
}
