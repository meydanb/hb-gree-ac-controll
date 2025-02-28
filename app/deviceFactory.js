const dgram = require('dgram');
//const socket = dgram.createSocket('udp4');
//var socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
const encryptionService = require('./encryptionService')();
const cmd = require('./commandEnums');

/**
 * Class representing a single connected device
 */
class Device {
//    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    /**
     * Create device model and establish UDP connection with remote host
     * @param {object} [options] Options
     * @param {string} [options.address] HVAC IP address
     * @callback [options.onStatus] Callback function run on each status update
     * @callback [options.onUpdate] Callback function run after command
     * @callback [options.onConnected] Callback function run once connection is established
      */
    constructor(options) {
        this.socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
        //  Set defaults
        this.options = {
            host: options.host,
            onStatus: options.onStatus || function() {},
            onUpdate: options.onUpdate || function() {},
            onConnected: options.onConnected || function() {},
            onError: options.onError || function() {},
            onDisconnected: options.onDisconnected || function() {},
            updateInterval: options.updateInterval || 10000,
            port: 8000 + parseInt(options.host.split('.')[3]),
        }

        /**
         * Device object
         * @typedef {object} Device
         * @property {string} id - ID
         * @property {string} name - Name
         * @property {string} address - IP address
         * @property {number} port - Port number
         * @property {boolean} bound - If is already bound
         * @property {object} props - Properties
         */
        var that = this;

        console.log("[GreeAC]: init deviceFactory on host %s [server port %s]", that.options.host, that.options.port);

        that.device = {};

        // Initialize connection and bind with device
        that._connectToDevice(that.options.host, that.options.port);

        // Handle incoming messages
        this.socket.on('message', (msg, rinfo) => that._handleResponse(msg, rinfo));
    }

    /**
     * Initialize connection
     * @param {string} address - IP/host address 
     */
    _connectToDevice(address, port) {
        var that = this;
        try {
            this.socket.bind(port, "0.0.0.0", () => {
                const message = new Buffer(JSON.stringify({t: 'scan'}));
                this.socket.setBroadcast(false);
                console.log("[GreeAC]: connecting to %s [using source port %d]", address, port);
                this.socket.send(message, 0, message.length, 7000, address);
            });
        } catch (err) {
            console.log("[GreeAC]: _connectToDevice error - port %d %s",port, err);
            const timeout = 5
            that.options.onDisconnected(that.device);
            setTimeout(() => {
                that._connectToDevice(address, port);
            }, timeout * 1000);
        }
    }

    /**
     * Register new device locally
     * @param {string} id - CID received in handshake message
     * @param {string} name - Device name received in handshake message
     * @param {string} address - IP/host address
     * @param {number} port - Port number
     */
    _setDevice (id, name, address, port) {
        var that = this;
        that.device.id = id;
        that.device.name = name;
        that.device.address = address;
        that.device.port = port;
        that.device.bound = false;
        that.device.props = {};
        console.log('[GreeAC] New device added: %s - %s', that.device.name, that.device.address);
    }

    /**
     * Send binding request to device
     * @param {Device} device Device object
     */
    _sendBindRequest(device) {
        var that = this;
        const message = {
            mac: that.device.id,
            t: 'bind',
            uid: 0
        };
        const encryptedBoundMessage = encryptionService.encrypt(message);
        const request = {
            cid: 'app',
            i: 1,
            t: 'pack',
            uid: 0,
            pack: encryptedBoundMessage
        };
        const toSend = new Buffer(JSON.stringify(request));
        this.socket.send(toSend, 0, toSend.length, device.port, device.address);
    }

    /**
     * Confirm device is bound and update device status on list
     * @param {String} id - Device ID
     * @param {String} key - Encryption key
     */
    _confirmBinding(id, key) {
        var that = this;
        that.device.bound = true;
        that.device.key = key;
        console.log('[GreeAC] device is bound: %s - %s', that.device.name, that.device.key);
    }

    /**
     * Confirm device is bound and update device status on list
     * @param {Device} device - Device
     */
    _requestDeviceStatus (device) {
        var that = this;
        const message = {
            cols: Object.keys(cmd).map(key => cmd[key].code),
            mac: device.id,
            t: 'status'
        };
        that._sendRequest(message, device.address, device.port);
    }

    /**
     * Handle UDP response from device
     * @param {string} msg Serialized JSON string with message
     * @param {object} rinfo Additional request information
     * @param {string} rinfo.address IP/host address
     * @param {number} rinfo.port Port number
     */
    _handleResponse(msg, rinfo) {
        var that = this;
        if (rinfo.address != that.options.host) {
        //console.log("We received response from %s but we are looking for %s",rinfo.address, that.options.host );
        return;
    }
        const message = JSON.parse(msg + '');
        try{
        // Extract encrypted package from message using device key (if available)
        const pack = encryptionService.decrypt(message, (that.device || {}).key);
        // If package type is response to handshake
        if (pack.t === 'dev') {
            that._setDevice(message.cid, pack.name, rinfo.address, rinfo.port);
            that._sendBindRequest(that.device);
            return;
        }

        // If package type is binding confirmation
        if (pack.t === 'bindok' && that.device.id) {
            that._confirmBinding(message.cid, pack.key);

            // Start requesting device status on set interval
            setInterval(that._requestDeviceStatus.bind(this, that.device), that.options.updateInterval);
            that.options.onConnected(that.device)
            return;
        }

        // If package type is device status
        if (pack.t === 'dat' && that.device.bound) {
            pack.cols.forEach((col, i) => {
                that.device.props[col] = pack.dat[i];
            });
            that.options.onStatus(that.device);
            return;
        }

        // If package type is response, update device properties
        if (pack.t === 'res' && that.device.bound) {
            pack.opt.forEach((opt, i) => {
                that.device.props[opt] = pack.val[i];
            });
            that.options.onUpdate(that.device);
            return;
        }
        that.options.onError(that.device);
        } catch (err) {
        that.options.onError(that.device);
        }
    }

    /**
     * Send commands to a bound device
     * @param {string[]} commands List of commands
     * @param {number[]} values List of values
     */
    _sendCommand (commands = [], values = []) {
        var that = this;
        const message = {
            opt: commands,
            p: values,
            t: 'cmd'
        };
        that._sendRequest(message);
    };

    /**
     * Send request to a bound device
     * @param {object} message
     * @param {string[]} message.opt
     * @param {number[]} message.p
     * @param {string} message.t
     * @param {string} [address] IP/host address
     * @param {number} [port] Port number
     */
    _sendRequest (message, address = this.device.address, port = this.device.port) {
        var that = this;
        const encryptedMessage = encryptionService.encrypt(message, this.device.key);
        const request = {
          cid: 'app',
          i: 0,
          t: 'pack',
          uid: 0,
          pack: encryptedMessage
        };
        const serializedRequest = new Buffer(JSON.stringify(request));
        this.socket.send(serializedRequest, 0, serializedRequest.length, port, address);
    };
    
    /**
     * Turn on/off
     * @param {boolean} value State
     */
    setPower (value) {
        var that = this;
        that._sendCommand(
            [cmd.power.code],
            [value ? 1 : 0]
        );
    };
    
    /**
     * Set temperature
     * @param {number} value Temperature
     * @param {number} [unit=0] Units (defaults to Celsius)
     */
    setTemp (value, unit = cmd.temperatureUnit.value.celsius) {
        var that = this;
        that._sendCommand(
            [cmd.temperatureUnit.code, cmd.temperature.code],
            [unit, value]
        );
    };
    
    /**
     * Set mode
     * @param {number} value Mode value (0-4)
     */
    setMode (value) {
        var that = this;
        that._sendCommand(
            [cmd.mode.code],
            [value]
        );
    };
    
    /**
     * Set fan speed
     * @param {number} value Fan speed value (0-5)
     */
    setFanSpeed (value) {
        var that = this;
        that._sendCommand(
            [cmd.fanSpeed.code],
            [value]
        );
    };
    
    /**
     * Set vertical swing
     * @param {number} value Vertical swing value (0-11)
     */
    setSwingVert (value) {
        var that = this;
        that._sendCommand(
            [cmd.swingVert.code],
            [value]
        );
    };

    setTurbo (value) {
        var that = this;
        that._sendCommand(
            [cmd.turbo.code],
            [value]
        );
    };
};

module.exports.connect = function(options) {
    return new Device(options);
};

