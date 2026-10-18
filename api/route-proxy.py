import hmac
import json
import math
import os
import time
import uuid
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def coordinates(point):
    return isinstance(point, list) and len(point) == 2 and all(number(v) for v in point) and abs(point[0]) <= 180 and abs(point[1]) <= 90


class handler(BaseHTTPRequestHandler):
    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        trace = uuid.uuid4().hex
        started = time.monotonic()
        stage = 'authorization'

        def log(step, **fields):
            print(json.dumps({'service': 'ors-proxy', 'id': trace, 'stage': step, 'elapsedMs': round((time.monotonic() - started) * 1000), **fields}), flush=True)

        token = os.environ.get('ROUTING_PROXY_TOKEN', '')
        key = os.environ.get('ORS_API_KEY', '')
        if not token or not key:
            return self.reply(503, {'error': 'Chưa cấu hình dịch vụ tính đường.'})
        if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
            return self.reply(401, {'error': 'Unauthorized'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2048:
                raise ValueError('Invalid size')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict) or not coordinates(data.get('start')) or not coordinates(data.get('end')):
                raise ValueError('Invalid coordinates')
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'Tọa độ không hợp lệ.'})
        request = urllib.request.Request(
            'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson',
            data=json.dumps({'coordinates': [data['start'], data['end']], 'instructions': False}).encode(),
            headers={'Authorization': key, 'Content-Type': 'application/json'},
        )
        stage = 'request'
        log(stage)
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                log('headers', status=response.status)
                stage = 'body'
                raw = response.read(4_000_001)
                log('body-complete', bytes=len(raw))
                stage = 'validation'
                if len(raw) > 4_000_000:
                    raise ValueError('Response too large')
                feature = json.loads(raw)['features'][0]
            geometry = feature['geometry']
            summary = feature['properties']['summary']
            points = geometry['coordinates']
            if geometry['type'] != 'LineString' or not 2 <= len(points) <= 100_000 or not all(coordinates(point) for point in points):
                raise ValueError('Invalid geometry')
            if not all(number(summary[k]) and summary[k] >= 0 for k in ('distance', 'duration')):
                raise ValueError('Invalid summary')
            log('complete')
            return self.reply(200, {'coordinates': points, 'distanceMeters': summary['distance'], 'durationSeconds': summary['duration']})
        except urllib.error.HTTPError as error:
            log('failed', failedStage=stage, errorType=type(error).__name__, status=error.code)
            return self.reply(503, {'error': f'Dịch vụ tính đường đang lỗi ({error.code}). Hãy thử lại sau.'})
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError) as error:
            log('failed', failedStage=stage, errorType=type(error).__name__, reasonType=type(getattr(error, 'reason', None)).__name__)
            return self.reply(504, {'error': 'Dịch vụ tính đường phản hồi chậm. Hãy thử lại sau.'})
