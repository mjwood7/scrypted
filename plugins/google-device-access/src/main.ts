import sdk, { DeviceManifest, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, HumiditySensor, MediaObject, MotionSensor, OauthClient, Refresh, ScryptedDeviceType, ScryptedInterface, Setting, Settings, TemperatureSetting, TemperatureUnit, Thermometer, ThermostatMode, VideoCamera, MediaStreamOptions, BinarySensor, DeviceInformation, BufferConverter, ScryptedMimeTypes, RTCAVMessage, RTCAVSource, Camera, PictureOptions, ObjectsDetected, ObjectDetector, ObjectDetectionTypes, FFMpegInput, RequestMediaStreamOptions, Readme } from '@scrypted/sdk';
import { ScryptedDeviceBase } from '@scrypted/sdk';
import qs from 'query-string';
import ClientOAuth2 from 'client-oauth2';
import { URL } from 'url';
import axios from 'axios';
import throttle from 'lodash/throttle';
import { createRTCPeerConnectionSource, getRTCMediaStreamOptions as getRtcMediaStreamOptions } from '../../../common/src/wrtc-ffmpeg-source';
import { sleep } from '../../../common/src/sleep';
import fs from 'fs';

const { deviceManager, mediaManager, endpointManager, systemManager } = sdk;

const refreshFrequency = 60;

const SdmSignalingPrefix = ScryptedMimeTypes.RTCAVSignalingPrefix + 'gda/';
const SdmDeviceSignalingPrefix = SdmSignalingPrefix + 'x-';
const black = fs.readFileSync('black.jpg');

const readmeV1 = fs.readFileSync('README-camera-v1.md').toString();
const readmeV2 = fs.readFileSync('README-camera-v2.md').toString();

function getSdmRtspMediaStreamOptions(): MediaStreamOptions {
    return {
        id: 'default',
        name: 'Cloud RTSP',
        container: 'rtsp',
        video: {
            codec: 'h264',
        },
        audio: {
            codec: 'aac',
        },
        source: 'cloud',
    };
}

function getSdmRtcMediaStreamOptions(signalingMime: string): MediaStreamOptions {
    const ret = getRtcMediaStreamOptions('webrtc', 'WebRTC', signalingMime);
    ret.source = 'cloud';
    return ret;
}

const NestRTCAVSource: RTCAVSource = {
    audio: {
        direction: 'recvonly',
    },
    video: {
        direction: 'recvonly',
    },
    datachannel: {
        label: 'dataSendChannel',
        dict: {
            id: 1,
        },
    },
}

function fromNestMode(mode: string): ThermostatMode {
    switch (mode) {
        case 'HEAT':
            return ThermostatMode.Heat;
        case 'COOL':
            return ThermostatMode.Cool;
        case 'HEATCOOL':
            return ThermostatMode.HeatCool;
        case 'OFF':
            return ThermostatMode.Off;
    }
}
function fromNestStatus(status: string): ThermostatMode {
    switch (status) {
        case 'HEATING':
            return ThermostatMode.Heat;
        case 'COOLING':
            return ThermostatMode.Cool;
        case 'OFF':
            return ThermostatMode.Off;
    }
}
function toNestMode(mode: ThermostatMode): string {
    switch (mode) {
        case ThermostatMode.Heat:
            return 'HEAT';
        case ThermostatMode.Cool:
            return 'COOL';
        case ThermostatMode.HeatCool:
            return 'HEATCOOL';
        case ThermostatMode.Off:
            return 'OFF';
    }
}

class NestCamera extends ScryptedDeviceBase implements Readme, Camera, VideoCamera, MotionSensor, BinarySensor, BufferConverter, ObjectDetector {
    signalingMime: string;
    lastMotionEventId: string;
    lastImage: Promise<Buffer>;

    constructor(public provider: GoogleSmartDeviceAccess, public device: any) {
        super(device.name.split('/').pop());
        this.provider = provider;
        this.device = device;

        this.signalingMime = SdmDeviceSignalingPrefix + this.nativeId;

        // create a mime unique to this this camera.
        this.fromMimeType = ScryptedMimeTypes.RTCAVOffer;
        this.toMimeType = this.signalingMime;
    }

    async getReadmeMarkdown(): Promise<string> {
        return this.isWebRtc ? readmeV2 : readmeV1;
    }

    // not sure if this works? there is a camera snapshot generate image thing, but it
    // does not exist on the new cameras.
    getDetectionInput(detectionId: any, eventId?: any): Promise<MediaObject> {
        throw new Error('Method not implemented.');
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return {
            classes: ['person'],
        }
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        // if this stream is prebuffered, its safe to use the prebuffer to generate an image
        const realDevice = systemManager.getDeviceById<VideoCamera>(this.id);
        try {
            const msos = await realDevice.getVideoStreamOptions();
            const prebuffered = msos.find(mso => mso.prebuffer);
            if (prebuffered)
                return realDevice.getVideoStream(prebuffered);
        }
        catch (e) {
        }

        // try to fetch the latest event image if one is queued
        const hasEventImages = !!this.device?.traits?.['sdm.devices.traits.CameraEventImage'];
        if (hasEventImages && this.lastMotionEventId) {
            const eventId = this.lastMotionEventId;
            this.lastMotionEventId = undefined;
            const result = this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
                command: "sdm.devices.commands.CameraEventImage.GenerateImage",
                params: {
                    eventId,
                },
            }).then(response => response.data);
            this.lastImage = result;
        }

        // use the last event image
        if (this.lastImage) {
            const data = await this.lastImage;
            return mediaManager.createMediaObject(data, 'image/jpeg');
        }

        // send "no snapshot available" image
        return mediaManager.createMediaObject(black, 'image/jpeg');
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return;
    }

    async convert(data: string | Buffer, fromMimeType: string): Promise<Buffer> {
        const offer: RTCAVMessage = JSON.parse(data.toString());
        const offerSdp = offer.description.sdp;
        const offerParts = offerSdp.split('m=');
        const audioPartIndex = offerParts.findIndex(part => part.startsWith('audio'));
        const [audioPart] = offerParts.splice(audioPartIndex, 1);
        offerParts.splice(1, 0, audioPart);
        offer.description.sdp = offerParts.join('m=');
        const { answer } = await this.sendOffer(offer);
        return Buffer.from(JSON.stringify(answer));
    }

    async sendOffer(offer: RTCAVMessage): Promise<{ result: any, answer: RTCAVMessage }> {
        const offerSdp = offer.description.sdp.replace('a=ice-options:trickle\r\n', '');

        const result = await this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
            command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
            params: {
                offerSdp,
            },
        });
        const { answerSdp } = result.data.results;
        const answer: RTCAVMessage = {
            id: undefined,
            description: {
                sdp: answerSdp,
                type: 'answer',
            },
            candidates: [],
            configuration: undefined,
        }
        return { result, answer };
    }

    addRefreshOptions(result: any, mso: MediaStreamOptions): MediaStreamOptions {
        const { expiresAt, streamToken, streamExtensionToken, mediaSessionId } = result.data.results;
        const expirationDate = new Date(expiresAt);
        const refreshAt = expirationDate.getTime();
        return Object.assign(mso, {
            refreshAt,
            metadata: {
                expiresAt,
                streamToken,
                streamExtensionToken,
                mediaSessionId,
            },
        });
    }

    createFFmpegMediaObject(result: any) {
        const u = result.data.results.streamUrls.rtspUrl;
        this.console.log('rtsp url', u);

        return mediaManager.createFFmpegMediaObject({
            url: u,
            mediaStreamOptions: this.addRefreshOptions(result, getSdmRtspMediaStreamOptions()),
            inputArguments: [
                "-rtsp_transport",
                "tcp",
                "-analyzeduration", "0",
                "-probesize", "1000000",
                "-reorder_queue_size", "1024",
                "-max_delay",
                "20000000",
                "-i",
                u.toString(),
            ],
        });
    }

    get isWebRtc() {
        return this.device?.traits?.['sdm.devices.traits.CameraLiveStream']?.supportedProtocols?.includes('WEB_RTC');
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        if (options?.metadata?.streamExtensionToken || options?.metadata?.mediaSessionId) {
            const { streamExtensionToken, mediaSessionId } = options?.metadata;
            const streamFormat = this.isWebRtc ? 'WebRtc' : 'Rtsp';
            const result = await this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
                command: `sdm.devices.commands.CameraLiveStream.Extend${streamFormat}Stream`,
                params: {
                    streamExtensionToken,
                    mediaSessionId,
                }
            });

            const mso = this.isWebRtc ? getSdmRtcMediaStreamOptions(this.signalingMime) : getSdmRtspMediaStreamOptions();
            this.addRefreshOptions(result, mso);

            const ffmpegInput: FFMpegInput = {
                url: undefined,
                mediaStreamOptions: mso,
                inputArguments: undefined,
            }
            return mediaManager.createFFmpegMediaObject(ffmpegInput);
        }

        if (this.isWebRtc) {
            return mediaManager.createMediaObject(Buffer.from(JSON.stringify(NestRTCAVSource)), this.signalingMime);
        }
        else {
            const result = await this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
                command: "sdm.devices.commands.CameraLiveStream.GenerateRtspStream",
                params: {}
            });
            return this.createFFmpegMediaObject(result);
        }
    }
    async getVideoStreamOptions(): Promise<MediaStreamOptions[]> {
        if (!this.isWebRtc) {
            return [
                getSdmRtspMediaStreamOptions(),
            ]
        }

        return [
            getSdmRtcMediaStreamOptions(this.signalingMime),
        ]
    }
}

const setpointMap = new Map<string, string>();
setpointMap.set('sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange', 'HEATCOOL');
setpointMap.set('sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat', 'HEAT');
setpointMap.set('sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool', 'COOL');

const setpointReverseMap = new Map<string, string>();
for (const [k, v] of setpointMap.entries()) {
    setpointReverseMap.set(v, k);
}

class NestThermostat extends ScryptedDeviceBase implements HumiditySensor, Thermometer, TemperatureSetting, Settings, Refresh {
    device: any;
    provider: GoogleSmartDeviceAccess;
    executeCommandSetMode: any = undefined;
    executeCommandSetCelsius: any = undefined;

    executeThrottle = throttle(async () => {
        if (this.executeCommandSetCelsius) {
            const mode = setpointMap.get(this.executeCommandSetCelsius.command);
            if (mode !== this.device.traits['sdm.devices.traits.ThermostatMode'].mode
                && this.executeCommandSetMode?.params.mode !== mode) {
                this.executeCommandSetMode = {
                    command: 'sdm.devices.commands.ThermostatMode.SetMode',
                    params: {
                        mode: mode,
                    },
                };
            }
        }
        if (this.executeCommandSetMode) {
            const command = this.executeCommandSetMode;
            this.executeCommandSetMode = undefined;
            this.console.log('executeCommandSetMode', command);
            await this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, command);
        }
        if (this.executeCommandSetCelsius) {
            const command = this.executeCommandSetCelsius;
            this.executeCommandSetCelsius = undefined;
            this.console.log('executeCommandSetCelsius', command);
            return this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, command);
        }
    }, 12000)

    constructor(provider: GoogleSmartDeviceAccess, device: any) {
        super(device.name.split('/').pop());
        this.provider = provider;
        this.device = device;

        this.reload();
    }

    async setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
        // not supported by API. throw?
    }

    reload() {
        const device = this.device;

        const modes: ThermostatMode[] = [];
        for (const mode of device.traits['sdm.devices.traits.ThermostatMode'].availableModes) {
            const nest = fromNestMode(mode);
            if (nest)
                modes.push(nest);
            else
                this.console.warn('unknown mode', mode);

        }
        this.thermostatAvailableModes = modes;
        this.thermostatMode = fromNestMode(device.traits['sdm.devices.traits.ThermostatMode'].mode);
        this.thermostatActiveMode = fromNestStatus(device.traits['sdm.devices.traits.ThermostatHvac'].status);
        // round the temperature to 1 digit to prevent state noise.
        this.temperature = Math.round(10 * device.traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius) / 10;
        this.humidity = Math.round(10 * device.traits["sdm.devices.traits.Humidity"].ambientHumidityPercent) / 10;
        this.temperatureUnit = device.traits['sdm.devices.traits.Settings'] === 'FAHRENHEIT' ? TemperatureUnit.F : TemperatureUnit.C;
        const heat = device.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
        const cool = device.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;

        if (this.thermostatMode === ThermostatMode.Heat) {
            this.thermostatSetpoint = heat;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
        else if (this.thermostatMode === ThermostatMode.Cool) {
            this.thermostatSetpoint = cool;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
        else if (this.thermostatMode === ThermostatMode.HeatCool) {
            this.thermostatSetpoint = undefined;
            this.thermostatSetpointHigh = heat;
            this.thermostatSetpointLow = cool;
        }
        else {
            this.thermostatSetpoint = undefined;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
    }

    async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
        const data = await this.provider.refresh();
        const device = data.devices.find(device => device.name.split('/').pop() === this.nativeId);
        if (!device)
            throw new Error('device missing from device list on refresh');
        this.device = device;
        this.reload();
    }

    async getRefreshFrequency(): Promise<number> {
        return refreshFrequency;
    }

    async getSettings(): Promise<Setting[]> {
        const ret: Setting[] = [];
        for (const key of Object.keys(this.device.traits['sdm.devices.traits.Settings'])) {
            ret.push({
                title: key,
                value: this.device.traits['sdm.devices.traits.Settings'][key],
                readonly: true,
            });
        }
        return ret;
    }
    async putSetting(key: string, value: string | number | boolean): Promise<void> {
    }
    async setThermostatMode(mode: ThermostatMode): Promise<void> {
        // set this in case round trip is slow.
        const nestMode = toNestMode(mode);
        this.device.traits['sdm.devices.traits.ThermostatMode'].mode = nestMode;

        this.executeCommandSetMode = {
            command: 'sdm.devices.commands.ThermostatMode.SetMode',
            params: {
                mode: nestMode,
            },
        }
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpoint(degrees: number): Promise<void> {
        const mode = this.device.traits['sdm.devices.traits.ThermostatMode'].mode;

        this.executeCommandSetCelsius = {
            command: setpointReverseMap.get(mode),
            params: {
            },
        };

        if (mode === 'HEAT' || mode === 'HEATCOOL')
            this.executeCommandSetCelsius.params.heatCelsius = degrees;
        if (mode === 'COOL' || mode === 'HEATCOOL')
            this.executeCommandSetCelsius.params.coolCelsius = degrees;
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpointHigh(high: number): Promise<void> {
        this.executeCommandSetCelsius = {
            command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange',
            params: {
                heatCelsius: high,
            },
        };
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpointLow(low: number): Promise<void> {
        this.executeCommandSetCelsius = {
            command: 'sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange',
            params: {
                coolCelsius: low,
            },
        };
        await this.executeThrottle();
        await this.refresh(null, true);
    }
}

class GoogleSmartDeviceAccess extends ScryptedDeviceBase implements OauthClient, DeviceProvider, Settings, HttpRequestHandler, BufferConverter {
    token: ClientOAuth2.Token;
    nestDevices = new Map<string, any>();
    devices = new Map<string, NestCamera | NestThermostat>();

    clientId: string;
    clientSecret: string;
    projectId: string;

    authorizationUri: string;
    client: ClientOAuth2;

    apiHostname: string;

    startup: Promise<void>;

    updateClient() {
        this.clientId = this.storage.getItem('clientId') || '827888101440-6jsq0saim1fh1abo6bmd9qlhslemok2t.apps.googleusercontent.com';
        this.clientSecret = this.storage.getItem('clientSecret') || 'nXgrebmaHNvZrKV7UDJV3hmg';
        this.projectId = this.storage.getItem('projectId');// || '778da527-9690-4368-9c96-6872bb29e7a0';
        if (!this.projectId) {
            this.log.a('Enter a valid project ID. Setup instructions for Nest: https://www.home-assistant.io/integrations/nest/');
        }

        const authorizationHostname = this.storage.getItem('authorizationHostname') || 'nestservices.google.com';
        this.authorizationUri = `https://${authorizationHostname}/partnerconnections/${this.projectId}/auth`
        this.client = new ClientOAuth2({
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            accessTokenUri: 'https://www.googleapis.com/oauth2/v4/token',
            authorizationUri: this.authorizationUri,
            scopes: [
                'https://www.googleapis.com/auth/sdm.service',
            ]
        });

        this.apiHostname = this.storage.getItem('apiHostname') || 'smartdevicemanagement.googleapis.com';
    }

    refreshThrottled = throttle(async () => {
        const response = await this.authGet('/devices');
        const userId = response.headers['user-id'];
        this.console.log('user-id', userId);
        return response.data;
    }, refreshFrequency * 1000);

    constructor() {
        super();
        this.updateClient();

        this.startup = (async () => {
            while (true) {
                try {
                    await this.discoverDevices(0);
                    return;
                }
                catch (e) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        })();

        this.fromMimeType = SdmSignalingPrefix + '*';
        this.toMimeType = ScryptedMimeTypes.FFmpegInput;
    }

    async convert(data: string | Buffer, fromMimeType: string): Promise<string | Buffer> {
        const nativeId = fromMimeType.substring(SdmDeviceSignalingPrefix.length);
        let device: NestCamera;
        for (const d of this.devices.values()) {
            if (d.nativeId.toLowerCase() === nativeId) {
                device = d as NestCamera;
                break;
            }
        }
        let streamResult: any;
        const result = await createRTCPeerConnectionSource(NestRTCAVSource, 'default', 'MPEG-TS', device.console, async (offer) => {
            const { result, answer } = await device.sendOffer(offer);
            streamResult = result;
            return answer;
        });
        device.addRefreshOptions(streamResult, result.ffmpegInput.mediaStreamOptions);
        return Buffer.from(JSON.stringify(result.ffmpegInput));
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const payload = JSON.parse(Buffer.from(JSON.parse(request.body).message.data, 'base64').toString());
        this.console.log(payload);

        const traits = payload.resourceUpdate?.traits;
        const events = payload.resourceUpdate?.events;

        const nativeId = payload.resourceUpdate?.name.split('/').pop();
        const device = this.nestDevices.get(nativeId);
        if (device) {
            if (traits) {
                Object.assign(device.traits, traits);
                if (device.type === 'sdm.devices.types.THERMOSTAT') {
                    const thermostat: NestThermostat = this.devices.get(nativeId) as any;
                    if (thermostat) {
                        thermostat.device = device;
                        thermostat?.reload();
                    }
                }
                // else if (device.type === 'sdm.devices.types.CAMERA' || device.type === 'sdm.devices.types.DOORBELL') {
                //     new NestCamera(this, device);
                // }
            }

            if (events) {
                if (events['sdm.devices.events.CameraMotion.Motion']
                    || events['sdm.devices.events.CameraPerson.Person']) {
                    const camera: NestCamera = this.devices.get(nativeId) as any;
                    if (camera) {
                        camera.motionDetected = true;
                        const eventId = events['sdm.devices.events.CameraMotion.Motion']?.eventId
                            || events['sdm.devices.events.CameraPerson.Person']?.eventId;
                        camera.lastMotionEventId = eventId;
                        // images expire in 30 seconds after publish
                        setTimeout(() => {
                            if (camera.lastMotionEventId === eventId)
                                camera.lastMotionEventId = undefined;
                        }, 30);
                        setTimeout(() => camera.motionDetected = false, 30000);
                        if (events['sdm.devices.events.CameraPerson.Person']) {
                            this.onDeviceEvent(ScryptedInterface.ObjectDetection, {
                                timestamp: Date.now(),
                                detections: [
                                    {
                                        className: 'person',
                                    },
                                ],
                            } as ObjectsDetected);
                        }
                    }
                }

                if (events['sdm.devices.events.DoorbellChime.Chime']) {
                    const camera: NestCamera = this.devices.get(nativeId) as any;
                    if (camera) {
                        camera.binaryState = true;
                        setTimeout(() => camera.binaryState = false, 30000);
                    }
                }
            }
        }

        response.send('ok');
    }

    async getSettings(): Promise<Setting[]> {
        let endpoint = 'Error retrieving Cloud Endpoint';
        try {
            endpoint = await endpointManager.getPublicCloudEndpoint();
        }
        catch (e) {
        }

        return [
            {
                key: 'projectId',
                title: 'Project ID',
                description: 'Google Device Access Project ID',
                value: this.storage.getItem('projectId'), // || '778da527-9690-4368-9c96-6872bb29e7a0',
            },
            {
                key: 'clientId',
                title: 'Google OAuth Client ID',
                description: 'Optional: The Google OAuth Client ID to use. The default value will use Scrypted Cloud OAuth login.',
                value: this.storage.getItem('clientId') || '827888101440-6jsq0saim1fh1abo6bmd9qlhslemok2t.apps.googleusercontent.com',
            },
            {
                key: 'clientSecret',
                title: 'Google OAuth Client Secret',
                description: 'Optional: The Google OAuth Client Secret to use. The default value will use Scrypted Cloud login.',
                value: this.storage.getItem('clientSecret') || 'nXgrebmaHNvZrKV7UDJV3hmg',
            },
            {
                title: "PubSub Address",
                description: "The PubSub address to enter in Google Cloud console.",
                key: 'pubsubAddress',
                readonly: true,
                value: endpoint,
                placeholder: 'http://somehost.dyndns.org',
            },
        ];
    }

    async putSetting(key: string, value: string | number | boolean): Promise<void> {
        this.storage.setItem(key, value as string);
        this.updateClient();
        this.token = undefined;
        this.refresh();
    }

    async loadToken() {
        try {
            if (!this.token) {
                this.token = this.client.createToken(JSON.parse(this.storage.getItem('token')));
                this.token.expiresIn(-1000);
            }
        }
        catch (e) {
            this.console.error('token error', e);
            this.log.a('Missing token. Please log in.');
            throw new Error('Missing token. Please log in.');
        }
        if (this.token.expired()) {
            this.token = await this.token.refresh();
            this.saveToken();
        }
    }

    saveToken() {
        this.storage.setItem('token', JSON.stringify(this.token.data));
    }

    async refresh(): Promise<any> {
        return this.refreshThrottled();
    }

    async getOauthUrl(): Promise<string> {
        const params = {
            client_id: this.clientId,
            access_type: 'offline',
            prompt: 'consent',
            response_type: 'code',
            scope: 'https://www.googleapis.com/auth/sdm.service',
        }
        return `${this.authorizationUri}?${qs.stringify(params)}`;
    }
    async onOauthCallback(callbackUrl: string) {
        const cb = new URL(callbackUrl);
        cb.search = '';
        const redirectUri = cb.toString();
        this.token = await this.client.code.getToken(callbackUrl, {
            redirectUri,
        });
        this.saveToken();

        this.discoverDevices(0).catch(() => { });
    }

    async authGet(path: string) {
        await this.loadToken();
        return axios(`https://${this.apiHostname}/v1/enterprises/${this.projectId}${path}`, {
            // validateStatus() {
            //     return true;
            // },
            headers: {
                Authorization: `Bearer ${this.token.accessToken}`
            }
        });
    }

    async authPost(path: string, data: any) {
        await this.loadToken();
        return axios.post(`https://${this.apiHostname}/v1/enterprises/${this.projectId}${path}`, data, {
            headers: {
                Authorization: `Bearer ${this.token.accessToken}`
            }
        });
    }

    async discoverDevices(duration: number): Promise<void> {
        let data: any;
        while (true) {
            try {
                // this call is throttled too, the sleep below is so the code doenst look weird
                data = await this.refresh();
                break;
            }
            catch (e) {
                this.console.error(e);
                await sleep(1000);
            }
        }

        const deviceManifest: DeviceManifest = {
            devices: [],
        };
        this.nestDevices.clear();
        for (const device of data.devices) {
            const nativeId = device.name.split('/').pop();
            const info: DeviceInformation = {
                manufacturer: 'Nest',
            };
            if (device.type === 'sdm.devices.types.THERMOSTAT') {
                this.nestDevices.set(nativeId, device);

                deviceManifest.devices.push({
                    name: device.traits?.['sdm.devices.traits.Info']?.customName || device.parentRelations?.[0]?.displayName,
                    nativeId: nativeId,
                    type: ScryptedDeviceType.Thermostat,
                    interfaces: [
                        ScryptedInterface.TemperatureSetting,
                        ScryptedInterface.HumiditySensor,
                        ScryptedInterface.Thermometer,
                        ScryptedInterface.Settings,
                    ],
                    info,
                })
            }
            else if (device.type === 'sdm.devices.types.CAMERA'
                || device.type === 'sdm.devices.types.DOORBELL'
                || device.type === 'sdm.devices.types.DISPLAY') {
                this.nestDevices.set(nativeId, device);

                const interfaces = [
                    ScryptedInterface.BufferConverter,
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Camera,
                    ScryptedInterface.MotionSensor,
                    ScryptedInterface.ObjectDetector,
                    ScryptedInterface.Readme,
                ];

                let type = ScryptedDeviceType.Camera;
                if (device.type === 'sdm.devices.types.DOORBELL') {
                    interfaces.push(ScryptedInterface.BinarySensor);
                    type = ScryptedDeviceType.Doorbell;
                }

                deviceManifest.devices.push({
                    name: device.traits?.['sdm.devices.traits.Info']?.customName || device.parentRelations?.[0]?.displayName,
                    nativeId: nativeId,
                    type,
                    interfaces,
                    info,
                })
            }
            else {
                this.console.log('unhandled device type', device.type);
            }
        }

        await deviceManager.onDevicesChanged(deviceManifest);
        for (const device of deviceManifest.devices) {
            this.getDevice(device.nativeId);
        }
    }

    async getDevice(nativeId: string) {
        await this.startup;
        let found = this.devices.get(nativeId);
        if (found)
            return found;
        const device = this.nestDevices.get(nativeId);
        if (!device)
            return;
        if (device.type === 'sdm.devices.types.THERMOSTAT')
            found = new NestThermostat(this, device);
        else if (device.type === 'sdm.devices.types.CAMERA'
            || device.type === 'sdm.devices.types.DOORBELL'
            || device.type === 'sdm.devices.types.DISPLAY')
            found = new NestCamera(this, device);

        this.devices.set(nativeId, found);
        return found;
    }
}

export default new GoogleSmartDeviceAccess();
