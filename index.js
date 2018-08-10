const si = require('systeminformation');
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');

const address = '192.168.1.128';
const port = 4242;

/**
 * send a UDP packet to the address:port
 * @param {string|string[]} message - the message(s) to send
 */
const sendMessage = (message) => {
	if (Array.isArray(message)) {
		message = message.join('\n');
	}

	udp.send(message, port, address, (err) => {
		console.log(err);
		udp.close();
	});
};

/**
 * format some input for statsd
 * @param {string} metric - metric name
 * @param {number} value - metric value
 * @param {string} type - metric type, one of 'c', 's', 'ms', or 'g'
 * @return {string} statsd-ready string
 */
const statsdFormat = (metric, value, type) => {
	const allowedMetrics = ['c', 's', 'g', 'ms'];
	if (!allowedMetrics.includes(type)) {
		throw new Error(`type ${type} is not a statsd metric`);
	}
	
	return `${metric}:${value}|${type}`;
};
