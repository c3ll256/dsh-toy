import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import WebSocket from "ws";
//#region src/types.ts
/** Error for invalid state, unsupported hardware, or protocol failures. */
var ToyError = class extends Error {
	/** @param message - Actionable operator or model-facing failure text. */
	constructor(message) {
		super(message);
		this.name = "ToyError";
	}
};
/** Return a detached device snapshot safe for callers to retain. */
function cloneDevices(devices) {
	return [...devices].map((device) => ({
		id: device.id,
		name: device.name,
		...device.displayName === void 0 ? {} : { displayName: device.displayName },
		features: device.features.map((feature) => ({
			id: feature.id,
			kind: feature.kind,
			description: feature.description
		}))
	}));
}
//#endregion
//#region src/websocket.ts
/** Shared bounded WebSocket primitives for both providers. */
/** Convert a received WebSocket frame into UTF-8 text. */
function frameText(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return data.toString("utf8");
}
/** Open a WebSocket with cooperative cancellation and a hard timeout. */
function openWebSocket(url, options, timeoutMs, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, options);
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			socket.off("open", onOpen);
			socket.off("error", onError);
			if (error === void 0) resolve(socket);
			else {
				socket.terminate();
				reject(error);
			}
		};
		const onOpen = () => {
			finish();
		};
		const onError = (error) => {
			finish(error);
		};
		const onAbort = () => {
			finish(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
		};
		const timeout = setTimeout(() => {
			finish(new ToyError(`WebSocket connection timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("open", onOpen);
		socket.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** Send a JSON value and wait until ws has handed it to the socket. */
function sendJson(socket, value) {
	return new Promise((resolve, reject) => {
		if (socket.readyState !== WebSocket.OPEN) {
			reject(new ToyError("WebSocket is not open"));
			return;
		}
		socket.send(JSON.stringify(value), (error) => {
			if (error === void 0 || error === null) resolve();
			else reject(error);
		});
	});
}
/** Close one socket and wait for the close event, terminating after a bound. */
function closeWebSocket(socket, timeoutMs = 1e3) {
	if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.off("close", finish);
			resolve();
		};
		const timeout = setTimeout(() => {
			socket.terminate();
			finish();
		}, timeoutMs);
		socket.once("close", finish);
		if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
		else socket.close(1e3, "dsh-toy shutdown");
	});
}
/** Abortable delay used for discovery windows. */
function delay(ms, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/buttplug.ts
/** Buttplug/Intiface WebSocket provider supporting protocol versions 3 and 4. */
function isObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value, key, fallback = "") {
	return typeof value[key] === "string" ? value[key] : fallback;
}
function numberField(value, key) {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : void 0;
}
function normalizeKind(value) {
	switch (value.toLowerCase()) {
		case "vibrate": return "vibrate";
		case "oscillate": return "oscillate";
		case "constrict": return "constrict";
		case "inflate": return "inflate";
		default: return;
	}
}
function protocolKind(kind) {
	switch (kind) {
		case "vibrate": return "Vibrate";
		case "oscillate": return "Oscillate";
		case "constrict": return "Constrict";
		case "inflate": return "Inflate";
		case "suction": throw new ToyError("Buttplug does not expose the MonsterParty-only suction action");
	}
}
function v3Features(device, deviceIndex) {
	const messages = device.DeviceMessages;
	if (!isObject$1(messages) || !Array.isArray(messages.ScalarCmd)) return [];
	const features = [];
	for (const [index, raw] of messages.ScalarCmd.entries()) {
		if (!isObject$1(raw)) continue;
		const rawKind = stringField(raw, "ActuatorType");
		const kind = normalizeKind(rawKind);
		if (kind === void 0) continue;
		features.push({
			id: `buttplug:${deviceIndex}:${index}:${kind}`,
			index,
			kind,
			description: stringField(raw, "FeatureDescriptor", `${rawKind} ${index}`),
			range: [0, 1]
		});
	}
	return features;
}
function v4Features(device, deviceIndex) {
	if (!isObject$1(device.DeviceFeatures)) return [];
	const features = [];
	for (const [mapIndex, raw] of Object.entries(device.DeviceFeatures)) {
		if (!isObject$1(raw) || !isObject$1(raw.Output)) continue;
		const index = numberField(raw, "FeatureIndex") ?? Number(mapIndex);
		if (!Number.isInteger(index) || index < 0) continue;
		for (const [outputType, rawOutput] of Object.entries(raw.Output)) {
			const kind = normalizeKind(outputType);
			if (kind === void 0 || !isObject$1(rawOutput) || !Array.isArray(rawOutput.Value)) continue;
			const min = rawOutput.Value[0];
			const max = rawOutput.Value[1];
			if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || max <= 0) continue;
			features.push({
				id: `buttplug:${deviceIndex}:${index}:${kind}`,
				index,
				kind,
				description: stringField(raw, "FeatureDescription", `${outputType} ${index}`),
				range: [min, max]
			});
		}
	}
	return features;
}
function parseDevice(raw, protocolVersion, fallbackIndex) {
	if (!isObject$1(raw)) return void 0;
	const index = numberField(raw, "DeviceIndex") ?? fallbackIndex;
	if (index === void 0 || !Number.isInteger(index) || index < 0) return void 0;
	return {
		id: `buttplug:${index}`,
		index,
		name: stringField(raw, "DeviceName", `Buttplug device ${index}`),
		...typeof raw.DeviceDisplayName === "string" ? { displayName: raw.DeviceDisplayName } : {},
		features: protocolVersion === 4 ? v4Features(raw, index) : v3Features(raw, index)
	};
}
function parseDeviceList(body, protocolVersion) {
	if (!isObject$1(body)) throw new ToyError("Buttplug DeviceList body is not an object");
	const devices = [];
	if (protocolVersion === 3) {
		if (!Array.isArray(body.Devices)) throw new ToyError("Buttplug v3 DeviceList.Devices is not an array");
		for (const raw of body.Devices) {
			const parsed = parseDevice(raw, protocolVersion);
			if (parsed !== void 0) devices.push(parsed);
		}
	} else {
		if (!isObject$1(body.Devices)) throw new ToyError("Buttplug v4 DeviceList.Devices is not a map");
		for (const [key, raw] of Object.entries(body.Devices)) {
			const parsed = parseDevice(raw, protocolVersion, Number(key));
			if (parsed !== void 0) devices.push(parsed);
		}
	}
	return devices;
}
/** Parse a DeviceList body from Buttplug v3 or v4 into the public snapshot. */
function parseButtplugDeviceList(body, protocolVersion) {
	return cloneDevices(parseDeviceList(body, protocolVersion));
}
function protocolMessages(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ToyError("Buttplug server sent invalid JSON");
	}
	if (!Array.isArray(parsed)) throw new ToyError("Buttplug frame is not a JSON array");
	const replies = [];
	for (const item of parsed) {
		if (!isObject$1(item)) continue;
		const entry = Object.entries(item)[0];
		if (entry === void 0 || !isObject$1(entry[1])) continue;
		replies.push({
			type: entry[0],
			body: entry[1]
		});
	}
	return replies;
}
function parseDeviceId(deviceId) {
	const match = /^buttplug:(\d+)$/.exec(deviceId);
	if (match === null) throw new ToyError(`Invalid Buttplug device id: ${deviceId}`);
	return Number(match[1]);
}
/** Stateful Buttplug JSON client over an Intiface WebSocket server. */
var ButtplugBackend = class {
	config;
	provider = "buttplug";
	socket;
	serverName = "";
	nextId = 0;
	pending = /* @__PURE__ */ new Map();
	devices = /* @__PURE__ */ new Map();
	pingTimer;
	/** @param config - Validated transport and protocol configuration. */
	constructor(config) {
		this.config = config;
	}
	async connect(signal) {
		if (this.socket?.readyState === WebSocket.OPEN) return {
			provider: this.provider,
			serverName: this.serverName,
			devices: this.list()
		};
		const socket = await openWebSocket(this.config.url, { perMessageDeflate: false }, this.config.connectionTimeoutMs, signal);
		this.socket = socket;
		socket.on("message", (data) => {
			this.receive(frameText(data));
		});
		socket.on("close", () => {
			this.loseConnection(new ToyError("Buttplug WebSocket closed"));
		});
		socket.on("error", (error) => {
			this.loseConnection(error);
			socket.terminate();
		});
		try {
			const handshake = this.config.protocolVersion === 4 ? {
				ClientName: this.config.clientName,
				ProtocolVersionMajor: 4,
				ProtocolVersionMinor: 0
			} : {
				ClientName: this.config.clientName,
				MessageVersion: 3
			};
			const reply = await this.request("RequestServerInfo", handshake, signal);
			if (reply.type !== "ServerInfo") throw new ToyError(`Expected ServerInfo, received ${reply.type}`);
			this.serverName = stringField(reply.body, "ServerName", "Intiface");
			const maxPingTime = numberField(reply.body, "MaxPingTime") ?? 0;
			this.startPings(maxPingTime);
			await this.refreshDevices(signal);
			return {
				provider: this.provider,
				serverName: this.serverName,
				devices: this.list()
			};
		} catch (error) {
			await closeWebSocket(socket);
			throw error;
		}
	}
	async scan(durationMs, signal) {
		this.assertConnected();
		await this.request("StartScanning", {}, signal);
		try {
			await delay(durationMs, signal);
		} finally {
			if (this.socket?.readyState === WebSocket.OPEN) await this.request("StopScanning", {}, void 0);
		}
		await this.refreshDevices(signal);
		return this.list();
	}
	list() {
		return cloneDevices(this.devices.values());
	}
	async setLevel(command, signal) {
		this.assertConnected();
		const deviceIndex = parseDeviceId(command.deviceId);
		const device = this.devices.get(deviceIndex);
		if (device === void 0) throw new ToyError(`Buttplug device is not available: ${command.deviceId}`);
		const features = device.features.filter((feature) => feature.kind === command.kind && (command.featureId === void 0 || feature.id === command.featureId));
		if (features.length === 0) throw new ToyError(`Device ${command.deviceId} has no matching ${command.kind} feature`);
		if (this.config.protocolVersion === 3) {
			await this.request("ScalarCmd", {
				DeviceIndex: deviceIndex,
				Scalars: features.map((feature) => ({
					Index: feature.index,
					Scalar: command.intensityPercent / 100,
					ActuatorType: protocolKind(feature.kind)
				}))
			}, signal);
			return;
		}
		for (const feature of features) {
			signal.throwIfAborted();
			const value = command.intensityPercent === 0 ? 0 : Math.max(feature.range[0], Math.round(feature.range[1] * command.intensityPercent / 100));
			await this.request("OutputCmd", {
				DeviceIndex: deviceIndex,
				FeatureIndex: feature.index,
				Command: { [protocolKind(feature.kind)]: { Value: value } }
			}, signal);
		}
	}
	async stop(deviceId, signal) {
		this.assertConnected();
		if (this.config.protocolVersion === 4) {
			await this.request("StopCmd", {
				...deviceId === void 0 ? {} : { DeviceIndex: parseDeviceId(deviceId) },
				Inputs: false,
				Outputs: true
			}, signal);
			return;
		}
		if (deviceId === void 0) await this.request("StopAllDevices", {}, signal);
		else await this.request("StopDeviceCmd", { DeviceIndex: parseDeviceId(deviceId) }, signal);
	}
	async close() {
		const socket = this.socket;
		if (socket === void 0) return;
		this.stopPings();
		let stopFailure;
		if (socket.readyState === WebSocket.OPEN) try {
			await this.stop(void 0);
		} catch (error) {
			stopFailure = error;
		}
		await closeWebSocket(socket);
		this.loseConnection(new ToyError("Buttplug client closed"));
		if (stopFailure !== void 0) throw stopFailure;
	}
	async refreshDevices(signal) {
		const reply = await this.request("RequestDeviceList", {}, signal);
		if (reply.type !== "DeviceList") throw new ToyError(`Expected DeviceList, received ${reply.type}`);
	}
	request(type, fields, signal) {
		const socket = this.assertConnected();
		signal?.throwIfAborted();
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const finish = (error, reply) => {
				const pending = this.pending.get(id);
				if (pending === void 0) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if (pending.signal !== void 0 && pending.onAbort !== void 0) pending.signal.removeEventListener("abort", pending.onAbort);
				if (error !== void 0) reject(error);
				else if (reply !== void 0) resolve(reply);
			};
			const onAbort = signal === void 0 ? void 0 : () => {
				finish(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			};
			const timer = setTimeout(() => {
				finish(new ToyError(`Buttplug ${type} timed out after ${this.config.requestTimeoutMs}ms`));
			}, this.config.requestTimeoutMs);
			this.pending.set(id, {
				timer,
				signal,
				onAbort,
				resolve,
				reject
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			sendJson(socket, [{ [type]: {
				Id: id,
				...fields
			} }]).catch((error) => {
				finish(error instanceof Error ? error : new ToyError(String(error)));
			});
		});
	}
	receive(raw) {
		let replies;
		try {
			replies = protocolMessages(raw);
		} catch {
			const socket = this.socket;
			this.loseConnection(new ToyError("Buttplug server sent a malformed frame"));
			socket?.close(1002, "invalid protocol frame");
			return;
		}
		for (const reply of replies) {
			try {
				this.applyEvent(reply);
			} catch (error) {
				const socket = this.socket;
				this.loseConnection(error instanceof Error ? error : new ToyError(String(error)));
				socket?.close(1002, "invalid protocol message");
				return;
			}
			const id = numberField(reply.body, "Id");
			if (id === void 0 || id === 0) continue;
			const pending = this.pending.get(id);
			if (pending === void 0) continue;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (pending.signal !== void 0 && pending.onAbort !== void 0) pending.signal.removeEventListener("abort", pending.onAbort);
			if (reply.type === "Error") pending.reject(new ToyError(stringField(reply.body, "ErrorMessage", "Buttplug request failed")));
			else pending.resolve(reply);
		}
	}
	applyEvent(reply) {
		if (reply.type === "DeviceList") {
			const parsed = parseDeviceList(reply.body, this.config.protocolVersion);
			this.devices.clear();
			for (const device of parsed) this.devices.set(device.index, device);
			return;
		}
		if (this.config.protocolVersion !== 3) return;
		if (reply.type === "DeviceAdded") {
			const device = parseDevice(reply.body, 3);
			if (device !== void 0) this.devices.set(device.index, device);
		} else if (reply.type === "DeviceRemoved") {
			const index = numberField(reply.body, "DeviceIndex");
			if (index !== void 0) this.devices.delete(index);
		}
	}
	startPings(maxPingTime) {
		this.stopPings();
		if (!Number.isFinite(maxPingTime) || maxPingTime <= 0) return;
		const interval = Math.max(100, Math.floor(maxPingTime / 2));
		this.pingTimer = setInterval(() => {
			this.request("Ping", {}, void 0).catch((error) => {
				const socket = this.socket;
				this.loseConnection(error instanceof Error ? error : new ToyError(String(error)));
				socket?.terminate();
			});
		}, interval);
	}
	stopPings() {
		if (this.pingTimer !== void 0) clearInterval(this.pingTimer);
		this.pingTimer = void 0;
	}
	loseConnection(error) {
		this.stopPings();
		this.socket = void 0;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (pending.signal !== void 0 && pending.onAbort !== void 0) pending.signal.removeEventListener("abort", pending.onAbort);
			pending.reject(error);
		}
	}
	assertConnected() {
		const socket = this.socket;
		if (socket === void 0 || socket.readyState !== WebSocket.OPEN) throw new ToyError("Not connected to Intiface; call toy_connect first");
		return socket;
	}
};
//#endregion
//#region src/monsterparty.ts
/** MonsterParty/Ankni remote-link provider based on the Chemtrails protocol notes. */
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSessionInfo(value) {
	if (!isObject(value) || !isObject(value.data)) throw new ToyError("MonsterParty session response has no data object");
	const socketUrl = value.data.socket_url;
	const sessionId = value.data.id;
	const userId = value.data.user_id;
	if (typeof socketUrl !== "string" || socketUrl.length === 0) throw new ToyError("MonsterParty session response has no socket_url");
	if (typeof sessionId !== "string" && typeof sessionId !== "number" || typeof userId !== "string" && typeof userId !== "number") throw new ToyError("MonsterParty session response has invalid id or user_id");
	return {
		socketUrl,
		sessionId,
		userId
	};
}
function parseFrame(raw) {
	try {
		const value = JSON.parse(raw);
		return isObject(value) ? value : void 0;
	} catch {
		return;
	}
}
/** In-process MonsterParty client with application heartbeats and dual-motor mapping. */
var MonsterPartyBackend = class {
	config;
	provider = "monsterparty";
	socket;
	senderFd;
	pid = "";
	keyType = "vib";
	dualMotor = false;
	ready = false;
	heartbeat;
	vibration = 0;
	suction = 0;
	/** @param config - Validated remote-link and heartbeat configuration. */
	constructor(config) {
		this.config = config;
	}
	async connect(signal) {
		if (this.socket?.readyState === WebSocket.OPEN && this.ready) return {
			provider: this.provider,
			serverName: "MonsterParty",
			devices: this.list()
		};
		const session = await this.resolveSession(signal);
		const socket = await openWebSocket(session.socketUrl, {
			headers: {
				Origin: this.config.origin,
				"User-Agent": this.config.userAgent
			},
			perMessageDeflate: false
		}, this.config.connectionTimeoutMs, signal);
		this.socket = socket;
		socket.on("close", () => {
			this.markDisconnected();
		});
		socket.on("error", () => {
			this.markDisconnected();
		});
		socket.on("message", (data) => {
			const message = parseFrame(frameText(data));
			if (message?.op === 15 && message.conn === false) this.ready = false;
		});
		try {
			await sendJson(socket, {
				op: 2,
				id: 8899001,
				gender: "male",
				remoteID: session.sessionId,
				senderID: session.userId,
				avatar: "",
				nickname: "dsh-toy",
				lat: 0,
				lng: 0,
				area: ""
			});
			await this.waitUntilReady(socket, signal);
			this.startHeartbeat(socket);
			return {
				provider: this.provider,
				serverName: "MonsterParty",
				devices: this.list()
			};
		} catch (error) {
			await closeWebSocket(socket);
			this.markDisconnected();
			throw error;
		}
	}
	async scan(_durationMs, signal) {
		signal.throwIfAborted();
		this.assertReady();
		return this.list();
	}
	list() {
		if (!this.ready) return [];
		return cloneDevices([{
			id: "monsterparty:remote",
			name: this.pid || "MonsterParty remote toy",
			features: [{
				id: "monsterparty:remote:vibration",
				kind: "vibrate",
				description: this.dualMotor ? "Vibration motor" : "All motors"
			}, ...this.dualMotor ? [{
				id: "monsterparty:remote:suction",
				kind: "suction",
				description: "Suction pump"
			}] : []]
		}]);
	}
	async setLevel(command, signal) {
		signal.throwIfAborted();
		const socket = this.assertReady();
		if (command.deviceId !== "monsterparty:remote") throw new ToyError(`Unknown MonsterParty device: ${command.deviceId}`);
		const featureId = command.featureId;
		if (featureId !== void 0 && featureId !== "monsterparty:remote:vibration" && featureId !== "monsterparty:remote:suction") throw new ToyError(`Unknown MonsterParty feature: ${featureId}`);
		if (featureId === "monsterparty:remote:suction" !== (command.kind === "suction") && featureId !== void 0) throw new ToyError(`MonsterParty feature ${featureId} does not match kind ${command.kind}`);
		let vibration = this.vibration;
		let suction = this.suction;
		if (command.kind === "suction") {
			if (!this.dualMotor) throw new ToyError("Connected MonsterParty device has no separate suction feature");
			suction = command.intensityPercent;
		} else if (command.kind === "vibrate") vibration = command.intensityPercent;
		else throw new ToyError(`MonsterParty does not support ${command.kind}`);
		await this.sendLevels(socket, vibration, suction);
		this.vibration = vibration;
		this.suction = suction;
	}
	async stop(deviceId, signal) {
		signal?.throwIfAborted();
		const socket = this.assertReady();
		if (deviceId !== void 0 && deviceId !== "monsterparty:remote") throw new ToyError(`Unknown MonsterParty device: ${deviceId}`);
		await this.sendLevels(socket, 0, 0);
		this.vibration = 0;
		this.suction = 0;
	}
	async close() {
		const socket = this.socket;
		if (socket === void 0) return;
		this.stopHeartbeat();
		let stopFailure;
		if (socket.readyState === WebSocket.OPEN && this.ready) try {
			await this.stop(void 0);
		} catch (error) {
			stopFailure = error;
		}
		await closeWebSocket(socket);
		this.markDisconnected();
		if (stopFailure !== void 0) throw stopFailure;
	}
	async resolveSession(signal) {
		const url = new URL(this.config.apiUrl);
		url.searchParams.set("s", this.config.sessionToken);
		const timeout = AbortSignal.timeout(this.config.connectionTimeoutMs);
		const response = await fetch(url, {
			signal: AbortSignal.any([signal, timeout]),
			headers: { "User-Agent": this.config.userAgent }
		});
		if (!response.ok) throw new ToyError(`MonsterParty session request failed with HTTP ${response.status}`);
		const value = await response.json();
		if (isObject(value) && typeof value.errNo === "number" && value.errNo !== 0) throw new ToyError(`MonsterParty rejected the share token (errNo ${value.errNo})`);
		return parseSessionInfo(value);
	}
	waitUntilReady(socket, signal) {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			let settled = false;
			let senderFd;
			let pid = "";
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", onAbort);
				socket.off("message", onMessage);
				socket.off("close", onClose);
				if (error !== void 0) {
					reject(error);
					return;
				}
				this.senderFd = senderFd;
				this.pid = pid;
				this.keyType = pid.toUpperCase().includes("SUCK") ? "suck" : "vib";
				this.dualMotor = pid.toUpperCase().includes("DS");
				this.ready = true;
				resolve();
			};
			const maybeReady = () => {
				if (senderFd !== void 0 && pid.length > 0) finish();
			};
			const onMessage = (data) => {
				const message = parseFrame(frameText(data));
				if (message === void 0) return;
				if (typeof message.errNo === "number" && message.errNo !== 0) {
					finish(new ToyError(`MonsterParty handshake failed (errNo ${message.errNo})`));
					return;
				}
				if (message.op === 6 && isObject(message.sender) && (typeof message.sender.fd === "number" || typeof message.sender.fd === "string")) senderFd = message.sender.fd;
				if (message.op === 15 && message.conn === true) pid = typeof message.pid === "string" ? message.pid : "MonsterParty toy";
				maybeReady();
			};
			const onClose = () => {
				finish(new ToyError("MonsterParty WebSocket closed before the device became ready"));
			};
			const onAbort = () => {
				finish(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			};
			const timeout = setTimeout(() => {
				finish(new ToyError(`MonsterParty device was not ready after ${this.config.readyTimeoutMs}ms; check power and use a fresh share link`));
			}, this.config.readyTimeoutMs);
			socket.on("message", onMessage);
			socket.once("close", onClose);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
	async sendLevels(socket, vibration, suction) {
		const fd = this.senderFd;
		if (fd === void 0) throw new ToyError("MonsterParty sender fd is unavailable");
		await sendJson(socket, {
			op: 3,
			vib: this.dualMotor ? [
				suction,
				vibration,
				vibration,
				vibration,
				vibration,
				0,
				0,
				0,
				0,
				0
			] : Array(10).fill(vibration),
			fd,
			keyType: this.keyType
		});
	}
	startHeartbeat(socket) {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			sendJson(socket, { op: 8 }).catch(() => {
				socket.terminate();
				this.markDisconnected();
			});
		}, this.config.heartbeatIntervalMs);
	}
	stopHeartbeat() {
		if (this.heartbeat !== void 0) clearInterval(this.heartbeat);
		this.heartbeat = void 0;
	}
	markDisconnected() {
		this.stopHeartbeat();
		this.socket = void 0;
		this.senderFd = void 0;
		this.ready = false;
		this.vibration = 0;
		this.suction = 0;
	}
	assertReady() {
		const socket = this.socket;
		if (!this.ready || socket === void 0 || socket.readyState !== WebSocket.OPEN) throw new ToyError("MonsterParty device is not connected; call toy_connect with a fresh configured token");
		return socket;
	}
};
//#endregion
//#region src/runtime.ts
/** Serialized safety layer over one concrete toy backend. */
/** Serializes transport operations and prevents stale auto-stop timers from stopping newer commands. */
var ToyRuntime = class {
	backend;
	safety;
	reportFailure;
	tail = Promise.resolve();
	stopTimers = /* @__PURE__ */ new Map();
	disposing = false;
	/**
	* @param backend - Concrete transport provider.
	* @param safety - Validated duration and intensity policy.
	* @param reportFailure - Sink for asynchronous auto-stop failures.
	*/
	constructor(backend, safety, reportFailure) {
		this.backend = backend;
		this.safety = safety;
		this.reportFailure = reportFailure;
	}
	/** Establish the provider connection. */
	connect(signal) {
		return this.exclusive(() => this.backend.connect(signal), signal);
	}
	/** Run provider discovery for a bounded interval. */
	scan(durationMs, signal) {
		return this.exclusive(() => this.backend.scan(durationMs, signal), signal);
	}
	/** Read the latest in-memory device snapshot. */
	list(signal) {
		return this.exclusive(() => Promise.resolve(this.backend.list()), signal);
	}
	/** Apply policy, send a scalar command, and schedule its exact-generation auto-stop. */
	control(request, signal) {
		const durationSeconds = request.intensityPercent === 0 ? 0 : request.durationSeconds ?? this.safety.defaultDurationSeconds;
		this.validateControl(request, durationSeconds);
		return this.exclusive(async () => {
			await this.backend.setLevel({
				deviceId: request.deviceId,
				...request.featureId === void 0 ? {} : { featureId: request.featureId },
				kind: request.kind,
				intensityPercent: request.intensityPercent
			}, signal);
			this.clearTimer(request.deviceId);
			if (request.intensityPercent > 0 && durationSeconds > 0) this.scheduleStop(request.deviceId, durationSeconds);
			return {
				deviceId: request.deviceId,
				kind: request.kind,
				intensityPercent: request.intensityPercent,
				autoStopSeconds: durationSeconds > 0 ? durationSeconds : null
			};
		}, signal);
	}
	/** Stop one device or all devices and cancel only the corresponding timers. */
	stop(deviceId, signal) {
		return this.exclusive(async () => {
			await this.backend.stop(deviceId, signal);
			if (deviceId === void 0) this.clearTimers();
			else this.clearTimer(deviceId);
		}, signal);
	}
	/** Disconnect without disposing the runtime, allowing a later reconnect. */
	disconnect(signal) {
		return this.exclusive(async () => {
			signal.throwIfAborted();
			this.clearTimers();
			await this.backend.close();
		}, signal);
	}
	/** Reject new operations, stop timers, and await provider shutdown. */
	async close() {
		if (this.disposing) {
			await this.tail;
			return;
		}
		this.disposing = true;
		await this.exclusive(async () => {
			this.clearTimers();
			await this.backend.close();
		}, void 0, true);
	}
	validateControl(request, durationSeconds) {
		if (!Number.isInteger(request.intensityPercent) || request.intensityPercent < 0 || request.intensityPercent > this.safety.maxIntensityPercent) throw new ToyError(`intensity_percent must be an integer from 0 to ${this.safety.maxIntensityPercent}`);
		if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > this.safety.maxDurationSeconds) throw new ToyError(`duration_seconds must be from 0 to ${this.safety.maxDurationSeconds}`);
		if (request.intensityPercent > 0 && durationSeconds === 0 && !this.safety.allowHold) throw new ToyError("duration_seconds=0 is disabled; use a positive duration or enable allowHold");
	}
	scheduleStop(deviceId, seconds) {
		const token = Symbol(deviceId);
		const timer = setTimeout(() => {
			this.exclusive(async () => {
				if (this.stopTimers.get(deviceId)?.token !== token) return;
				this.stopTimers.delete(deviceId);
				await this.backend.stop(deviceId);
			}, void 0).catch((error) => {
				try {
					this.reportFailure(error);
				} catch {}
			});
		}, seconds * 1e3);
		this.stopTimers.set(deviceId, {
			token,
			timer
		});
	}
	clearTimer(deviceId) {
		const current = this.stopTimers.get(deviceId);
		if (current === void 0) return;
		clearTimeout(current.timer);
		this.stopTimers.delete(deviceId);
	}
	clearTimers() {
		for (const timer of this.stopTimers.values()) clearTimeout(timer.timer);
		this.stopTimers.clear();
	}
	exclusive(operation, signal, allowDisposing = false) {
		if (this.disposing && !allowDisposing) return Promise.reject(new ToyError("dsh-toy is shutting down"));
		let release;
		const predecessor = this.tail;
		this.tail = new Promise((resolve) => {
			release = resolve;
		});
		return (async () => {
			await predecessor;
			try {
				if (this.disposing && !allowDisposing) throw new ToyError("dsh-toy is shutting down");
				signal?.throwIfAborted();
				return await operation();
			} finally {
				release();
			}
		})();
	}
};
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-toy";
/** Harness services required by the model-facing consumer. */
const inject = ["tools"];
const Config = z.object({
	provider: z.union(["buttplug", "monsterparty"]).default("buttplug"),
	buttplugUrl: z.string().default("ws://127.0.0.1:12345"),
	buttplugProtocolVersion: z.union([3, 4]).default(4),
	monsterPartySessionToken: z.string(),
	monsterPartyApiUrl: z.string().default("https://api.monsterparty.cc/main/v1/remote"),
	monsterPartyOrigin: z.string().default("https://www.monsterparty.cn"),
	clientName: z.string().default("dsh-toy"),
	connectionTimeoutMs: z.number().default(1e4),
	requestTimeoutMs: z.number().default(5e3),
	readyTimeoutMs: z.number().default(2e4),
	heartbeatIntervalMs: z.number().default(9e3),
	scanDurationMs: z.number().default(5e3),
	defaultDurationSeconds: z.number().default(30),
	maxDurationSeconds: z.number().default(300),
	maxIntensityPercent: z.number().default(100),
	allowHold: z.boolean().default(false)
});
const USER_AGENT = "Mozilla/5.0 (compatible; dsh-toy/0.1; +https://github.com/deepseek-ai/deepseek-harness)";
function positiveInteger(config, key) {
	const value = config[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-toy: ${String(key)} must be a positive safe integer`);
}
function nonNegativeNumber(config, key) {
	const value = config[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`dsh-toy: ${String(key)} must be a finite non-negative number`);
}
/** Resolve configuration and fail plugin load on unsafe or incomplete values. */
function resolveConfig(config) {
	const resolved = config;
	for (const key of [
		"connectionTimeoutMs",
		"requestTimeoutMs",
		"readyTimeoutMs",
		"heartbeatIntervalMs",
		"scanDurationMs"
	]) positiveInteger(resolved, key);
	for (const key of [
		"defaultDurationSeconds",
		"maxDurationSeconds",
		"maxIntensityPercent"
	]) nonNegativeNumber(resolved, key);
	if (resolved.defaultDurationSeconds > resolved.maxDurationSeconds) throw new Error("dsh-toy: defaultDurationSeconds cannot exceed maxDurationSeconds");
	if (!Number.isSafeInteger(resolved.maxIntensityPercent) || resolved.maxIntensityPercent > 100) throw new Error("dsh-toy: maxIntensityPercent must be a safe integer from 0 to 100");
	if (resolved.provider === "monsterparty" && (resolved.monsterPartySessionToken?.length ?? 0) === 0) throw new Error("dsh-toy: monsterPartySessionToken is required for the monsterparty provider");
	try {
		const url = new URL(resolved.provider === "buttplug" ? resolved.buttplugUrl : resolved.monsterPartyApiUrl);
		if (!(resolved.provider === "buttplug" ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol)) throw new Error("unsupported URL protocol");
	} catch {
		throw new Error(`dsh-toy: invalid ${resolved.provider === "buttplug" ? "buttplugUrl" : "monsterPartyApiUrl"}`);
	}
	return resolved;
}
function createBackend(config) {
	if (config.provider === "monsterparty") return new MonsterPartyBackend({
		sessionToken: config.monsterPartySessionToken,
		apiUrl: config.monsterPartyApiUrl,
		origin: config.monsterPartyOrigin,
		userAgent: USER_AGENT,
		connectionTimeoutMs: config.connectionTimeoutMs,
		readyTimeoutMs: config.readyTimeoutMs,
		heartbeatIntervalMs: config.heartbeatIntervalMs
	});
	return new ButtplugBackend({
		url: config.buttplugUrl,
		protocolVersion: config.buttplugProtocolVersion,
		connectionTimeoutMs: config.connectionTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
		clientName: config.clientName
	});
}
const FEATURE_KINDS = [
	"vibrate",
	"oscillate",
	"constrict",
	"inflate",
	"suction"
];
const DEVICE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		name: {
			type: "string",
			required: true
		},
		displayName: { type: "string" },
		features: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: FEATURE_KINDS
					},
					description: {
						type: "string",
						required: true
					}
				}
			}
		}
	}
};
function devicesValue(devices) {
	return devices;
}
/** Register the connection, discovery, control, stop, and disconnect tools. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const runtime = new ToyRuntime(createBackend(resolved), {
		defaultDurationSeconds: resolved.defaultDurationSeconds,
		maxDurationSeconds: resolved.maxDurationSeconds,
		maxIntensityPercent: resolved.maxIntensityPercent,
		allowHold: resolved.allowHold
	}, (error) => {
		ctx.logger.warn(`dsh-toy automatic stop failed: ${String(error)}`);
	});
	ctx.effect(() => () => runtime.close(), "dsh-toy transport teardown");
	ctx.tools.register(defineTool({
		name: "toy_connect",
		description: "Connect to the configured toy provider. Secrets come only from plugin config and are never tool arguments.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					provider: {
						type: "string",
						required: true,
						enum: ["buttplug", "monsterparty"]
					},
					serverName: {
						type: "string",
						required: true
					},
					devices: {
						type: "array",
						required: true,
						items: DEVICE_SCHEMA
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (_args, exec) => runtime.connect(exec.signal),
		presentCall: () => ({
			card: "generic",
			title: "Connect toy provider",
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "toy_scan",
		description: "Scan for devices using the deployment-configured bounded discovery window.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: DEVICE_SCHEMA
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (_args, exec) => devicesValue(await runtime.scan(resolved.scanDurationMs, exec.signal)),
		presentCall: () => ({
			card: "generic",
			title: "Scan for toys",
			kind: "search"
		})
	}));
	ctx.tools.register(defineTool({
		name: "toy_list",
		description: "List currently known devices and their safe scalar features without starting a scan.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: DEVICE_SCHEMA
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (_args, exec) => devicesValue(await runtime.list(exec.signal)),
		presentCall: () => ({
			card: "generic",
			title: "List toys",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "toy_control",
		description: `Set a scalar toy feature from 0-${resolved.maxIntensityPercent}%. Commands auto-stop by default; duration 0 is ${resolved.allowHold ? "enabled" : "disabled"}.`,
		parameters: {
			device_id: {
				type: "string",
				required: true,
				description: "Opaque id returned by toy_list or toy_scan."
			},
			feature_id: {
				type: "string",
				description: "Optional exact feature id. Omit to target all matching features."
			},
			kind: {
				type: "string",
				required: true,
				enum: FEATURE_KINDS,
				description: "Scalar action supported by the target feature."
			},
			intensity_percent: {
				type: "number",
				required: true,
				description: `Integer percentage from 0 to ${resolved.maxIntensityPercent}.`
			},
			duration_seconds: {
				type: "number",
				description: `Seconds before automatic stop. Omit for ${resolved.defaultDurationSeconds}; maximum ${resolved.maxDurationSeconds}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					deviceId: {
						type: "string",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: FEATURE_KINDS
					},
					intensityPercent: {
						type: "number",
						required: true
					},
					autoStopSeconds: {
						oneOf: [{ type: "number" }, { type: "null" }],
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (args, exec) => runtime.control({
			deviceId: args.device_id,
			...args.feature_id === void 0 ? {} : { featureId: args.feature_id },
			kind: args.kind,
			intensityPercent: args.intensity_percent,
			...args.duration_seconds === void 0 ? {} : { durationSeconds: args.duration_seconds }
		}, exec.signal),
		presentCall: (args) => ({
			card: "generic",
			title: `Set toy ${args.kind} to ${args.intensity_percent}%`,
			kind: "other",
			rawInput: {
				deviceId: args.device_id,
				durationSeconds: args.duration_seconds
			}
		})
	}));
	ctx.tools.register(defineTool({
		name: "toy_stop",
		description: "Immediately stop one device, or every connected device when device_id is omitted.",
		parameters: { device_id: {
			type: "string",
			description: "Opaque device id. Omit for the global emergency stop."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { stopped: {
					type: "string",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (args, exec) => {
			await runtime.stop(args.device_id, exec.signal);
			return { stopped: args.device_id ?? "all" };
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.device_id === void 0 ? "Stop all toys" : "Stop toy",
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "toy_disconnect",
		description: "Stop all output and disconnect the configured provider. A later toy_connect can reconnect.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { disconnected: {
					type: "boolean",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		execute: async (_args, exec) => {
			await runtime.disconnect(exec.signal);
			return { disconnected: true };
		},
		presentCall: () => ({
			card: "generic",
			title: "Disconnect toy provider",
			kind: "other"
		})
	}));
}
//#endregion
export { ButtplugBackend, Config, MonsterPartyBackend, ToyError, ToyRuntime, apply, inject, name, parseButtplugDeviceList, resolveConfig };
