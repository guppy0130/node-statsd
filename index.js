const si = require('systeminformation');
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');
const service = require('os-service');
const os = require('os');
const hostname = os.hostname();

const address = '192.168.1.128';        // statsd address
const port = 8125;                      // statsd port
const prefix = '_t_';                   // prefix to be used with statsd-opentsdb-backend
const interval = 1000;                  // interval in ms
const debug = false;                     // enable when debugging

process.chdir(__dirname);

const run = () => {
    /**
     * Creates a tag object
     * @param {string} tag - tag name
     * @param {string|number} value - tag value
     * @return tag object
     */
    const tag = (tag, value) => {
        const format = (input) => {
            if (typeof input === 'string') {
                return input.replace(/\./g, '-').replace(/ /g, '-');
            }
            return input;
        };

        return {
            tag: format(tag),
            value: format(value)
        };
    };

    /**
     * send a UDP packet to the address:port
     * @param {string|string[]} message - the message(s) to send
     */
    const send = (message) => {
        if (Array.isArray(message)) {
            message = message.join('\n');
        }
        

        if (!debug) {
            udp.send(message, port, address, (err) => {
                if (err) {
                    console.log(err);
                }
            });
        } else {
            console.log(message);
        }
    };

    /**
     * format some input for statsd
     * @param {string} metric - metric name
     * @param {number} value - metric value
     * @param {string} type - metric type, one of 'c', 's', 'ms', or 'g'
     * @param {Tag[]} moreTags - any additional tag objects to send; default adds hostname
     * @return {string} statsd-ready string
     */
    const statsdFormat = (metric, value, type, moreTags) => {
        const allowedMetrics = ['c', 's', 'g', 'ms'];
        let tags;
        
        /**
         * perform type check
         */
        if (!allowedMetrics.includes(type)) {
            throw new Error(`${JSON.stringify(type)} is not a statsd metric type (one of 'c', 's', 'ms', or 'g')`);
        }

        /**
         * parse through all the tags, adding the prefix and formatting tags for sending
         * add the default hostname tag
         */
        moreTags = moreTags || [];
        moreTags.push(tag('hostname', hostname));
        tags = moreTags.map(elem => {
            return `${prefix}${elem.tag}.${elem.value}`;
        }).join('.');

        return `${metric}.${tags}:${value}|${type}`;
    };

    /**
     * gets the current cpu usage and sends it
     * will also tag by CPU
     */
    const getCpuUsage = () => {
        si.currentLoad()
            .then(data => {
                data.cpus.forEach((cpu, index) => {
                    cpu.load = Math.round(cpu.load);
                    send(statsdFormat('cpu_usage', cpu.load, 'c', [tag('cpu', index)]));
                });
            })
            .catch(err => {
                throw err;
            });
    };

    /**
     * get the current memory use and sends it
     * wants two metrics: ram + swap
     * tags with 'free', 'used', or 'active' depending on if it's appropriate
     */
    const getMemory = () => {
        si.mem()
            .then(data => {
                let total = data.total;
                let swapTotal = data.swaptotal;

                let mem = ['free', 'used', 'active'],
                    swap = ['free', 'used'];

                let arr = mem.map(elem => {
                    return statsdFormat('ram', Math.round(data[elem] / total * 10000) / 10000, 'c', [tag('memory', elem)]);
                }).concat(
                    swap.map(elem => {
                        return statsdFormat('swap', Math.round(data[`swap${elem}`] / swapTotal * 10000) / 10000, 'c', [tag('memory', elem)]);
                    })
                );

                send(arr);
            })
            .catch(err => {
                throw err;
            });
    };
    
    /**
     * gets current network use and sends it
     * tags with 'direction' (rx/tx) and 'interface'
     */
    const getNetworkUse = () => {
        si.networkInterfaces()
            .then(interfaces => {
                return interfaces.filter(iface => !iface.internal).map(iface => { return iface.iface; });
            })
            .then(usableInterfaces => {
                usableInterfaces.map(iface => {
                    si.networkStats(iface, data => {
                        if (data.tx_sec > -1 && data.rx_sec > -1) {
                            send([
                                statsdFormat('network', data.rx_sec, 'c', [tag('interface', iface), tag('direction', 'rx')]),
                                statsdFormat('network', data.tx_sec, 'c', [tag('interface', iface), tag('direction', 'tx')])
                            ]);
                        }
                    });
                });
            })
            .catch(err => {
                throw err;
            });
    };
    
    let latency = -1;
    /**
     * gets the network latency to 8.8.8.8 and sends it
     * this is a gauge instead due to its infrequency
     */
    const getLatency = () => {
        if (latency === -1) {
            send(statsdFormat('latency', 0, 'g'));
        }
        
        si.inetLatency(ms => {
            let value = ms - latency;
            if (value >= 0) {
                value = `+${value}`;
            }
            send(statsdFormat('latency', value, 'g'));
            latency = ms;
        });
    };
    
    let disks = {};
    /**
     * disk usage/capacity
     */
    const getDiskUsage = () => {
        si.fsSize(mounted => {
            mounted.forEach(device => {
                let calc = Math.round(device.use * 1000) / 1000;
                let mount = device.mount.replace(':', '');
                let value;
                
                if (disks[mount] !== undefined) {
                    value = disks[mount] - calc;
                    if (value >= 0) {
                        value = `+${value}`;
                    }
                } else {
                    value = calc;
                }
                send(statsdFormat('disk_usage', value, 'g', [
                    tag('type', device.type), 
                    tag('mount', mount), 
                    tag('fs', device.fs.replace(':', ''))
                ]));
                disks[mount] = calc;
            });
        });
    };

    let battery = -1;
    /**
     * get battery stats
     */
    const getBattery = () => {
        si.battery(data => {
            if (!data.hasbattery) {
                return;
            } else if (battery === -1) {
                send(statsdFormat('battery', data.percent, 'g'));
                battery = data.percent;
                return;
            }
            let value = data.percent - battery;
            if (value >= 0) {
                value = `+${value}`;
            }
            send(statsdFormat('battery', value, 'g'));
        });
    };

    /**
     * gets uptime
     */
    const getUptime = () => {
        send(statsdFormat('uptime', si.time().uptime, 'c'));
    };
    
    /**
     * get disk i/o
     */
    const getDiskIO = async () => {
        let {platform} = await si.osInfo();
        if (platform === 'win32') {
            return;
        }
        si.disksIO(data => {
            let rio = data.rIO_sec;
            let wio = data.wIO_sec;
            send(statsdFormat('diskio', rio, 'c', [tag('direction', 'read')]));
            send(statsdFormat('diskio', wio, 'c', [tag('direction', 'write')]));
        });
    };

    /**
     * convenience function for high frequency data
     */
    const getHighFreq = () => {
        getCpuUsage();
        getMemory();
        getNetworkUse();
        getUptime();
        getDiskIO();
    };
    
    /**
     * convenience function for fx's that aren't as often used
     */
    const getMedFreq = () => {
        getLatency();
        getDiskUsage();
        getBattery();
    };

    /**
     * get/send information at intervals of 1, 10
     */
    setInterval(getHighFreq, interval);
    setInterval(getMedFreq, interval * 10);
    getMedFreq();

    /**
     * every so often, re-send gauge values instead of deltas
     */
    const sendRaw = () => {
        battery = -1;
        latency = -1;
        disks = {};
        getMedFreq();
    };

    setInterval(sendRaw, interval * 100);
};

/**
 * Register as a service (Linux/Windows)
 */
const usage = () => {
    console.log('usage: node index.js --add [username] [password]');
    console.log('       node index.js --remove');
    console.log('       node index.js --run');
    process.exit(0);
};

if (process.argv[2] === '--add' && process.argv.length >= 3) {
    const options = {
        args: ['--run']
    };

    if (process.argv.length > 3) {
        options.username = process.argv[3];
    }

    if (process.argv.length === 4) {
        options.password = process.argv[4];
    }

    console.log('adding service...');
    service.add('node-statsd', options, err => {
        if (err) {
            throw err;
        } else {
            console.log(`service added. Metrics sending to ${address}:${port}`);
        }
    });
} else if (process.argv[2] === '--remove') {
    console.log('removing service...');
    service.remove('node-statsd', err => {
        if (err) {
            throw err;
        } else {
            console.log('service removed');
        }
    });
} else if (process.argv[2] === '--run') {
    service.run(() => {
        console.log('stopping...');
        udp.close();
        service.stop();
    });

    console.log('running...');
    run();
} else {
    usage();
}
