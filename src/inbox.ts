/** An async queue a query reads its input from, so messages can be pushed while it runs. */
export class Inbox<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#waiting: ((result: IteratorResult<T>) => void) | undefined;
	#closed = false;

	push(item: T) {
		if (this.#closed) return;
		const waiting = this.#waiting;
		if (waiting) {
			this.#waiting = undefined;
			waiting({ value: item, done: false });
		} else {
			this.#items.push(item);
		}
	}

	close() {
		this.#closed = true;
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.#items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.#closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.#waiting = resolve;
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}
