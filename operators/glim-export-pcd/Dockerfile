FROM python:3.11-slim

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="glim-export-pcd"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

RUN pip install --no-cache-dir numpy -i https://mirrors.aliyun.com/pypi/simple/
RUN mkdir -p /opt/scripts

COPY export_map_pcd.py /opt/scripts/export_map_pcd.py
COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]
