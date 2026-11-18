# =============================================================================
# CloudDesk - atajos. Ejecuta `make` para ver la ayuda.
# =============================================================================
SHELL := /usr/bin/env bash
COMPOSE := docker compose
.DEFAULT_GOAL := help
.PHONY: help bootstrap up down restart build logs ps shell desktop-shell \
        password cert renew smoke backup restore update test lint dev install-systemd \
        audit e2e e2e-selftest codespaces codespaces-stop release provision

help: ## Muestra esta ayuda
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap: ## Configuración inicial (.env, secretos, certificado temporal)
	@./scripts/bootstrap.sh

up: ## Construye y arranca el stack
	@$(COMPOSE) up -d --build

down: ## Detiene el stack (los datos se conservan)
	@$(COMPOSE) down

restart: ## Reinicia los contenedores
	@$(COMPOSE) restart

build: ## Reconstruye las imágenes
	@$(COMPOSE) build

logs: ## Sigue los registros
	@$(COMPOSE) logs -f --tail=100

ps: ## Estado de los servicios
	@$(COMPOSE) ps

shell: ## Shell en el contenedor del escritorio (usuario desk)
	@$(COMPOSE) exec desktop runuser -u desk -- bash

desktop-shell: shell ## Alias de shell

password: ## Cambia la contraseña del panel
	@./scripts/set-password.sh

cert: ## Emite el certificado de Let's Encrypt
	@./scripts/issue-cert.sh

renew: ## Renueva el certificado y recarga nginx
	@./scripts/renew-cert.sh

smoke: ## Prueba de humo contra el despliegue
	@./scripts/smoke-test.sh

backup: ## Copia de seguridad (.env, certificados, perfil)
	@./scripts/backup.sh

restore: ## Restaura una copia: make restore FILE=backups/...
	@test -n "$(FILE)" || { echo "uso: make restore FILE=backups/clouddesk-....tar.gz"; exit 1; }
	@./scripts/restore.sh "$(FILE)"

update: ## Reconstruye y recrea los servicios
	@./scripts/update.sh

test: ## Pruebas unitarias y de integración del API
	@cd api && npm test

http-check: ## Comprobaciones HTTP contra el API de desarrollo (make dev)
	@node api/tools/http-checks.mjs

ui-check: ## Verificación visual 390x844 y 1280x900 (make dev + Chrome)
	@node tools/ui-check.mjs

lint: ## Validación estática de scripts, Python, JS y compose
	@for f in scripts/*.sh; do bash -n "$$f" || exit 1; done
	@python3 -m py_compile desktop/rootfs/opt/clouddesk/*.py
	@node --check api/src/server.js
	@node --check api/tools/mock-agent.mjs
	@node --check api/tools/dev-proxy.mjs
	@node --check api/tools/http-checks.mjs
	@node --check gateway/web/assets/app.js
	@node --check gateway/web/assets/desktop.js
	@node --check tools/ui-check.mjs
	@docker compose config >/dev/null 2>&1 || echo "aviso: 'docker compose config' no disponible en este equipo"
	@echo "lint: ok"

dev: ## Entorno local sin Docker (mock agent + API + proxy)
	@./scripts/dev-local.sh

dev-lan: ## Entorno local accesible desde el iPhone en la misma Wi-Fi
	@./scripts/dev-local.sh --lan

install-systemd: ## Instala las unidades systemd (requiere /opt/clouddesk)
	@sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
	@sudo systemctl daemon-reload
	@sudo systemctl enable --now clouddesk.service clouddesk-renew.timer clouddesk-backup.timer
	@sudo systemctl status --no-pager clouddesk.service

audit: ## Auditoría estática del repositorio (archivos, secretos, hashes)
	@node tools/repo-audit.mjs

e2e-selftest: ## Valida la herramienta E2E con Chrome local (sin servidor)
	@node tools/e2e-desktop.mjs --selftest

e2e: ## Prueba real contra el escritorio con CDP (requiere CLOUDDESK_E2E_DEBUG=1)
	@node tools/e2e-desktop.mjs

codespaces: ## Construye y arranca el escritorio en Codespaces
	@./scripts/codespaces-up.sh

codespaces-stop: ## Detiene el escritorio de Codespaces
	@./scripts/codespaces-up.sh --stop

release: ## Genera el paquete de distribución: make release VERSION=1.0.0
	@test -n "$(VERSION)" || { echo "uso: make release VERSION=1.0.0"; exit 1; }
	@./scripts/make-release.sh "$(VERSION)" dist

provision: ## Aprovisiona la VM (Oracle/Ubuntu): sudo make provision ARGS="--nip --yes"
	@sudo ./scripts/provision-oracle.sh $(ARGS)
