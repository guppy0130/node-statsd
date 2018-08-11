const si = require('systeminformation');
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');
const service = require('os-service');
const os = require('os');
const colors = require('colors/safe');
const hostname = os.hostname();

const address = '192.168.1.128';        // statsd address
const port = 8125;                      // statsd port
const prefix = '_t_';                   // prefix to be used with statsd-opentsdb-backend
const interval = 1000;                  // interval in ms

let debug = process.env.PRODUCTION == 'true';
process.chdir(__dirname);

const run = () => {
    /**
     * Creates a tag object
     * @param {string} tag - tag name
     * @param {string|number} value - tag value
     * @return tag object
     */
    const tag = (tag, value) => {
        return {
            tag: tag,
            value: value
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
        
        udp.send(message, port, address, (err) => {
            if (err) {
                console.log(err);
            }
        });
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
            throw new Error(`${type} is not a statsd metric type (one of 'c', 's', 'ms', or 'g')`);
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

        if (debug) {
            //console.log(`[${(new Date).toLocaleString()}] ${metric}.${tags}:${value}|${type}`);
//            console.table({
//                metric: metric,
//                tags: tags,
//                value: value,
//                type: type
//            });
        }
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
                console.log(value);
                send(statsdFormat('disk_usage', value, 'g', [
                    tag('type', device.type), 
                    tag('mount', mount), 
                    tag('fs', device.fs.replace(':', ''))
                ]));
                disks[mount] = calc;
            });
        });
    };
    
    const getInfo = () => {
        si.getStaticData(data => {
            const {graphics, memLayout} = data;
            const l1 = ['system', 'bios', 'baseboard', 'os', 'versions'];
            const l2 = [
                ['model'],
                ['vendor', 'releaseDate'],
                ['model', 'version'],
                ['platform', 'arch', 'distro', 'release'],
                ['kernel', 'openssl', 'node', 'npm', 'yarn', 'gulp', 'git', 'mongodb']
            ];
            
            l1.forEach((l1Elem, index) => {
                l2[index].forEach((l2Elem) => {
                    console.log(l1Elem, l2Elem);
                    //send(
                    console.log(
                        statsdFormat('info', data[l1Elem][l2Elem].replace(/\./g, '-').replace(/ /g, '-'), 'g', [tag(l1Elem, l2Elem)])
                    );
                    //);
                });
            });
            
            graphics.controllers.forEach(gpu => {
                statsdFormat('info', gpu.model, 'g', [tag('graphics', 'model')]);
                statsdFormat('info', gpu.vendor, 'g', [tag('graphics', 'vendor')]);
                statsdFormat('info', gpu.bus, 'g', [tag('graphics', 'bus')]);
                statsdFormat('info', gpu.vram, 'g', [tag('graphics', 'vram')]);
            });
            
            memLayout.forEach(stick => {
                statsdFormat('info', stick.clockSpeed, 'g', [tag('memLayout', 'clockSpeed')]);
                statsdFormat('info', stick.voltageConfigured, 'g', [tag('memLayout', 'voltageConfigured')]);
                statsdFormat('info', stick.bank, 'g', [tag('memLayout', 'bank')]);
            });
        });
    };
    
    debug = true;
    
    /**
     * convenience function for high frequency data
     */
    const getHighFreq = () => {
        getCpuUsage();
        getMemory();
        getNetworkUse();
    };
    
    /**
     * convenience function for fx's that aren't as often used
     */
    const getMedFreq = () => {
        getLatency();
        getDiskUsage();
    };
    
    /**
     * for run-once functions
     */
    const getNoFreq = () => {
        getInfo();
    };
    
    /**
     * get/send information at intervals of 1, 100
     */
    setInterval(getHighFreq, interval);
    setInterval(getMedFreq, interval * 10);
    getMedFreq();
    getNoFreq();
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
