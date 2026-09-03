import { config } from '../../config.js';
import * as mock from './mock.js';
import * as gmail from './gmail.js';

const drivers = { mock, gmail };
export const mailer = drivers[config.mailDriver] || mock;
