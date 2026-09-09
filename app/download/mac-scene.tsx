"use client";

import { Bounds, useGLTF, useTexture } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo } from "react";
import {
	Box3,
	type Material,
	Mesh,
	MeshBasicMaterial,
	type MeshStandardMaterial,
	NeutralToneMapping,
	SRGBColorSpace,
	Vector3,
} from "three";
import { Studio } from "./phone-scene";

export function MacBook({ onReady }: { onReady: () => void }) {
	const { scene } = useGLTF("/download/macbook-m5.glb", "/download/draco/");
	const screenshot = useTexture("/download/mac-wallet-1237.png");
	const invalidate = useThree((state) => state.invalidate);
	const renderScene = useThree((state) => state.scene);
	const model = useMemo(() => {
		const root = scene.clone(true);
		// Map the app window edge-to-edge, excluding the capture's outer desktop margin.
		const texture = screenshot.clone();
		texture.flipY = false;
		texture.offset.set(56 / 1440, 38 / 900);
		texture.repeat.set(1328 / 1440, 812 / 900);
		texture.colorSpace = SRGBColorSpace;
		texture.anisotropy = 8;
		texture.needsUpdate = true;
		const materials: Material[] = [];
		root.traverse((child) => {
			if (!(child instanceof Mesh) || Array.isArray(child.material)) return;
			if ((child.material as MeshStandardMaterial).isMeshStandardMaterial) {
				const material = child.material.clone() as MeshStandardMaterial;
				material.envMapIntensity = 0.25;
				// Keycaps and rubber use separate, low-metalness materials.
				if (
					[
						"IqdrVPEOaZqbHHo",
						"HzlgDKVNnMxfNgM",
						"vJOGifqMXcmlCkF",
						"kMkIQgtfAZdmtyc",
						"sqkqSXQCeccDMmm",
						"waAAeDqzqDLObIi",
					].includes(material.name)
				) {
					material.color.set("#0b0b0d");
					material.envMapIntensity = 0.035;
					material.roughness = 0.85;
				}
				// Keep the space-black metal dark under the landing page's studio lights.
				if (material.metalness > 0.5 || material.metalnessMap) {
					material.color.set("#141416");
					material.envMapIntensity = 0.04;
					material.roughness = Math.max(material.roughness, 0.5);
					material.metalness = 0.65;
				}
				child.material = material;
				materials.push(material);
			}
			if (child.material.name === "HlQwFCAPWzetDQy") {
				const display = new MeshBasicMaterial({
					map: texture,
					toneMapped: false,
				});
				child.material = display;
				materials.push(display);
			}
		});
		const box = new Box3().setFromObject(root);
		const scale = 3 / box.getSize(new Vector3()).x;
		root.scale.setScalar(scale);
		root.position.copy(box.getCenter(new Vector3()).multiplyScalar(-scale));
		return { root, materials, texture };
	}, [scene, screenshot]);
	useEffect(() => {
		for (const material of model.materials) {
			if ((material as MeshStandardMaterial).isMeshStandardMaterial) {
				(material as MeshStandardMaterial).envMap = renderScene.environment;
				material.needsUpdate = true;
			}
		}
		invalidate();
		onReady();
	}, [invalidate, onReady, model, renderScene]);
	useEffect(() => {
		model.texture.needsUpdate = true;
		for (const material of model.materials) material.needsUpdate = true;
		invalidate();
		return () => {
			for (const material of model.materials) material.dispose();
			model.texture.dispose();
		};
	}, [model, invalidate]);
	return (
		<group rotation={[0, 0.34, 0]}>
			<primitive object={model.root} dispose={null} />
		</group>
	);
}

export default function MacScene({ onReady }: { onReady: () => void }) {
	return (
		<Canvas
			camera={{ fov: 30, position: [0, 0.35, 8] }}
			dpr={[1, 1.75]}
			frameloop="demand"
			gl={{ alpha: true, antialias: true, toneMapping: NeutralToneMapping }}
		>
			<Studio />
			<directionalLight intensity={0.6} position={[-3, 5, 5]} />
			<directionalLight intensity={0.25} position={[4, 1, 3]} />
			<Suspense fallback={null}>
				<Bounds fit clip observe margin={1.08}>
					<MacBook onReady={onReady} />
				</Bounds>
			</Suspense>
		</Canvas>
	);
}
