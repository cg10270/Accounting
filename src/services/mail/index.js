import { config } from '../../config.js';
import * as mock from './mock.js';
import * as gmail from './gmail.js';
import * as imap from './imap.js';

const drivers = { mock, gmail, imap };
export const mailer = drivers[config.mailDriver] || mock;
